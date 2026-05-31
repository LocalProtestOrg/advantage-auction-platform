'use strict';

/**
 * AI Catalog Assistant — lot_ai_verifications data-access layer (Phase 2A.2).
 *
 * APPEND-ONLY provenance store for the Seller Verification Layer. Exposes ONLY
 * an insert (recordVerificationEvent) and reads (getLatestVerification,
 * listVerifications). No update/delete is provided — the original AI output
 * must never be lost or mutated (mirrors the audit_log philosophy).
 *
 * SCOPE (Phase 2A.2): this module is the storage API only. It is intentionally
 * NOT imported by any route, the AI generate/refine endpoints, the seller UI,
 * the admin UI, or audit integration — those are post-checkpoint phases. It is
 * shipped now so the persistence seam is defined, tested, and reviewable.
 */

const db = require('../db/index');
const { isValidSelection } = require('../constants/clarificationCategories');

const EVENT_TYPES = ['generate', 'refine', 'final'];

/**
 * Append one verification event. Provenance fields (image_url, ai_model,
 * prompt_version, event_type) are required; everything else is event-shaped.
 * If seller_selections is provided it must validate against the clarification
 * registry — forged/garbage selections are rejected before they reach storage.
 *
 * @param {object} e  the event fields (snake or camel accepted below)
 * @param {object} [client]  optional pg client for transactional writes
 * @returns {Promise<object>} the inserted row { id, created_at, ... }
 */
async function recordVerificationEvent(e, client = null) {
  if (!e || typeof e !== 'object') throw new Error('verification event payload required');

  const eventType = e.eventType || e.event_type;
  if (!EVENT_TYPES.includes(eventType)) {
    throw new Error(`event_type must be one of: ${EVENT_TYPES.join(', ')}`);
  }
  const imageUrl      = e.imageUrl      || e.image_url;
  const aiModel       = e.aiModel       || e.ai_model;
  const promptVersion = e.promptVersion || e.prompt_version;
  if (!imageUrl)      throw new Error('image_url is required');
  if (!aiModel)       throw new Error('ai_model is required');
  if (!promptVersion) throw new Error('prompt_version is required');

  const sellerSelections = e.sellerSelections !== undefined ? e.sellerSelections : e.seller_selections;
  if (sellerSelections != null && !isValidSelection(sellerSelections)) {
    throw new Error('seller_selections failed clarification-registry validation');
  }

  const clarificationSchema = e.clarificationSchema !== undefined ? e.clarificationSchema : e.clarification_schema;

  const sql = `
    INSERT INTO lot_ai_verifications (
      lot_id, draft_correlation, seller_user_id,
      image_url, ai_model, prompt_version, event_type,
      ai_title, ai_description, ai_category,
      clarification_schema, seller_selections, final_description
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13)
    RETURNING *
  `;
  const params = [
    e.lotId            || e.lot_id            || null,
    e.draftCorrelation || e.draft_correlation || null,
    e.sellerUserId     || e.seller_user_id    || null,
    imageUrl,
    aiModel,
    promptVersion,
    eventType,
    e.aiTitle          || e.ai_title          || null,
    e.aiDescription    || e.ai_description     || null,
    e.aiCategory       || e.ai_category        || null,
    clarificationSchema != null ? JSON.stringify(clarificationSchema) : null,
    sellerSelections    != null ? JSON.stringify(sellerSelections)    : null,
    e.finalDescription || e.final_description  || null,
  ];

  const runner = client || db;
  const result = await runner.query(sql, params);
  return result.rows[0];
}

/** Most-recent verification row for a lot (admin "current" view). */
async function getLatestVerification(lotId) {
  const { rows } = await db.query(
    `SELECT * FROM lot_ai_verifications
      WHERE lot_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [lotId]
  );
  return rows[0] || null;
}

/** Full append-only history for a lot, newest first (admin/dispute view). */
async function listVerifications(lotId) {
  const { rows } = await db.query(
    `SELECT * FROM lot_ai_verifications
      WHERE lot_id = $1
      ORDER BY created_at DESC`,
    [lotId]
  );
  return rows;
}

module.exports = {
  EVENT_TYPES,
  recordVerificationEvent,
  getLatestVerification,
  listVerifications,
};
