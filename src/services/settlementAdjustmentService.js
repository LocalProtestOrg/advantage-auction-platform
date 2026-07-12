'use strict';

/**
 * settlementAdjustmentService — data-access + audit for manual settlement
 * adjustments (Increment 2 foundation; Decision 4). Thin and transactional: each
 * mutation writes its audit_log row atomically with the change (auditService).
 *
 * Adjustments are inert until the settlement engine (Increment 3) consumes them via
 * settlementPolicy.sumAdjustments(). Removal is a soft VOID, never a hard delete, so
 * the audit trail is preserved.
 */

const db = require('../db');
const auditService = require('./auditService');
const { ADJUSTMENT_TYPE, SETTLEMENT_AUDIT_EVENTS } = require('../lib/settlementPolicy');

class SettlementAdjustmentError extends Error {}

// Immutability guard: a paid settlement's adjustments cannot be added/edited/voided.
async function assertSettlementMutable(client, auctionId) {
  const r = await client.query('SELECT settlement_status FROM seller_payouts WHERE auction_id = $1', [auctionId]);
  if (r.rows[0] && r.rows[0].settlement_status === 'paid') {
    throw new SettlementAdjustmentError('Settlement is paid and immutable; adjustments cannot be changed.');
  }
}

// Resolve the seller's user id from the auction (canonical ownership chain).
async function resolveSellerUserId(client, auctionId) {
  const r = await client.query(
    `SELECT sp.user_id AS seller_user_id
       FROM auctions a JOIN seller_profiles sp ON sp.id = a.seller_id
      WHERE a.id = $1`,
    [auctionId]
  );
  if (!r.rows[0]) throw new SettlementAdjustmentError('Auction not found');
  return r.rows[0].seller_user_id;
}

/**
 * Add a manual credit or debit adjustment to an auction's settlement.
 * @returns the inserted row
 */
async function addAdjustment({ auctionId, type, amountCents, reason, notes = null, category = null, actorId = null }) {
  if (type !== ADJUSTMENT_TYPE.CREDIT && type !== ADJUSTMENT_TYPE.DEBIT) {
    throw new SettlementAdjustmentError("Invalid adjustment type (must be 'credit' or 'debit')");
  }
  const cents = Math.trunc(Number(amountCents));
  if (!Number.isFinite(cents) || cents <= 0) {
    throw new SettlementAdjustmentError('amountCents must be a positive integer number of cents');
  }
  if (!reason || !String(reason).trim()) {
    throw new SettlementAdjustmentError('reason is required');
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const sellerUserId = await resolveSellerUserId(client, auctionId);
    await assertSettlementMutable(client, auctionId); // block once paid
    const ins = await client.query(
      `INSERT INTO settlement_adjustments
         (auction_id, seller_user_id, adjustment_type, amount_cents, reason, notes, category, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [auctionId, sellerUserId, type, cents, String(reason).trim(), notes, category, actorId]
    );
    const row = ins.rows[0];
    await auditService.logEvent(client, {
      eventType: SETTLEMENT_AUDIT_EVENTS.ADJUSTMENT_ADDED,
      entityType: 'settlement_adjustment',
      entityId: row.id,
      auctionId,
      actorId,
      metadata: { adjustment_type: type, amount_cents: cents, reason: row.reason, category, notes, seller_user_id: sellerUserId },
    });
    await client.query('COMMIT');
    return row;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** List an auction's adjustments (active only by default). */
async function listAdjustments(auctionId, { includeVoided = false } = {}) {
  const r = await db.query(
    `SELECT * FROM settlement_adjustments
      WHERE auction_id = $1 ${includeVoided ? '' : 'AND voided_at IS NULL'}
      ORDER BY created_at ASC`,
    [auctionId]
  );
  return r.rows;
}

/**
 * Soft-void an adjustment (preserves the audit trail; never deletes).
 * @returns the updated row, or null if not found / already voided
 */
async function voidAdjustment({ adjustmentId, actorId = null, voidReason = null }) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query('SELECT auction_id FROM settlement_adjustments WHERE id = $1', [adjustmentId]);
    if (cur.rows[0]) await assertSettlementMutable(client, cur.rows[0].auction_id); // block once paid
    const upd = await client.query(
      `UPDATE settlement_adjustments
          SET voided_at = now(), voided_by_user_id = $2, void_reason = $3
        WHERE id = $1 AND voided_at IS NULL
        RETURNING *`,
      [adjustmentId, actorId, voidReason]
    );
    const row = upd.rows[0] || null;
    if (row) {
      await auditService.logEvent(client, {
        eventType: SETTLEMENT_AUDIT_EVENTS.ADJUSTMENT_REMOVED,
        entityType: 'settlement_adjustment',
        entityId: row.id,
        auctionId: row.auction_id,
        actorId,
        metadata: { void_reason: voidReason, previous: { adjustment_type: row.adjustment_type, amount_cents: row.amount_cents } },
      });
    }
    await client.query('COMMIT');
    return row;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { addAdjustment, listAdjustments, voidAdjustment, SettlementAdjustmentError };
