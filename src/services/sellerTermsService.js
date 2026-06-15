'use strict';

/**
 * sellerTermsService — per-seller financial/contractual terms, HISTORY-PRESERVING.
 * setTerms appends a new current row and supersedes the prior (one current row
 * per seller, enforced by a partial unique index). Full history is retained for
 * auditability and reporting. Every change writes a seller_terms_changed audit.
 */
const db = require('../db/index');
const { writeAuditLog } = require('../lib/auditLog');

const TERMS_FIELDS = [
  'commission_pct', 'buyer_premium_pct', 'credit_card_fee_pct',
  'marketing_fee_cents', 'settlement_terms', 'payout_schedule',
  // Buyer Premium Phase 1: internal BP split + optional hammer commission (defaults).
  'aac_bp_share_pct', 'aac_hammer_commission_pct',
];

async function getCurrentTerms(sellerProfileId) {
  const { rows } = await db.query(
    'SELECT * FROM seller_terms WHERE seller_profile_id = $1 AND superseded_at IS NULL',
    [sellerProfileId]
  );
  return rows[0] || null;
}

async function getHistory(sellerProfileId) {
  const { rows } = await db.query(
    'SELECT * FROM seller_terms WHERE seller_profile_id = $1 ORDER BY effective_from DESC',
    [sellerProfileId]
  );
  return rows;
}

// Append a new current terms row (patch merged over the existing current row).
async function setTerms(sellerProfileId, patch, actorId) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(
      'SELECT * FROM seller_terms WHERE seller_profile_id = $1 AND superseded_at IS NULL FOR UPDATE',
      [sellerProfileId]
    );
    const current = cur.rows[0] || {};
    const merged = {};
    for (const f of TERMS_FIELDS) merged[f] = (patch[f] !== undefined) ? patch[f] : (current[f] ?? null);

    if (cur.rows[0]) {
      await client.query('UPDATE seller_terms SET superseded_at = now() WHERE id = $1', [cur.rows[0].id]);
    }
    const ins = await client.query(
      `INSERT INTO seller_terms
         (seller_profile_id, commission_pct, buyer_premium_pct, credit_card_fee_pct,
          marketing_fee_cents, settlement_terms, payout_schedule,
          aac_bp_share_pct, aac_hammer_commission_pct, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [sellerProfileId, merged.commission_pct, merged.buyer_premium_pct, merged.credit_card_fee_pct,
       merged.marketing_fee_cents, merged.settlement_terms, merged.payout_schedule,
       merged.aac_bp_share_pct, merged.aac_hammer_commission_pct, actorId ?? null]
    );
    await client.query('COMMIT');

    await writeAuditLog({
      event_type: 'seller_terms_changed', entity_type: 'seller_terms',
      entity_id: ins.rows[0].id, actor_id: actorId ?? null,
      metadata: { seller_profile_id: sellerProfileId, before: cur.rows[0] || null, after: ins.rows[0] },
    });
    return ins.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { TERMS_FIELDS, getCurrentTerms, getHistory, setTerms };
