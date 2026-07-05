'use strict';

/**
 * marketplaceService — admin-only marketplace visibility controls (Constitution §7).
 * Partner auctions are syndicated by default; ONLY platform admins may hide / show /
 * remove / restore / feature / promote. Every override is written to audit_log.
 */

const db = require('../db');
const { svcErr } = require('../utils/apiError');
const auditService = require('./auditService');

const VISIBILITY = {
  hide:    { status: 'hidden',     type: 'marketplace.hidden' },
  show:    { status: 'syndicated', type: 'marketplace.shown' },
  remove:  { status: 'removed',    type: 'marketplace.removed' },
  restore: { status: 'syndicated', type: 'marketplace.restored' },
};

async function setVisibility(adminId, auctionId, action, reason) {
  const spec = VISIBILITY[action];
  if (!spec) throw svcErr(400, 'INVALID_ACTION', 'Unknown marketplace action.');
  const { rows } = await db.query(
    `UPDATE auctions
        SET marketplace_status = $2, is_syndicated = ($2 = 'syndicated'),
            marketplace_updated_at = now(), marketplace_updated_by = $3
      WHERE id = $1
      RETURNING id, marketplace_status, is_syndicated, is_featured, is_promoted`,
    [auctionId, spec.status, adminId]);
  if (!rows.length) throw svcErr(404, 'AUCTION_NOT_FOUND', 'Auction not found.');
  await auditService.logEvent(db, {
    eventType: spec.type, entityType: 'auction', entityId: auctionId, auctionId,
    actorId: adminId, metadata: { reason: reason || null },
  });
  return rows[0];
}

async function setFlag(adminId, auctionId, flag, value) {
  const col = flag === 'feature' ? 'is_featured' : flag === 'promote' ? 'is_promoted' : null;
  if (!col) throw svcErr(400, 'INVALID_FLAG', 'Unknown marketplace flag.');
  const { rows } = await db.query(
    `UPDATE auctions SET ${col} = $2, marketplace_updated_at = now(), marketplace_updated_by = $3
      WHERE id = $1 RETURNING id, marketplace_status, is_featured, is_promoted`,
    [auctionId, !!value, adminId]);
  if (!rows.length) throw svcErr(404, 'AUCTION_NOT_FOUND', 'Auction not found.');
  await auditService.logEvent(db, {
    eventType: 'marketplace.' + flag + (value ? '_set' : '_cleared'), entityType: 'auction', entityId: auctionId,
    auctionId, actorId: adminId, metadata: { value: !!value },
  });
  return rows[0];
}

module.exports = { setVisibility, setFlag, VISIBILITY };
