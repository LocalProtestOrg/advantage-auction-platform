/**
 * ⚠️ DEPRECATED — DO NOT USE. Retained pre-launch for reference only.
 *
 * - NOT WIRED into the application: no module imports this file.
 * - OBSOLETE SCHEMA ASSUMPTIONS: references auctions.seller_profile_id,
 *   auctions.created_by_user_id, and auctions.status — none of which exist in
 *   the deployed schema (db/migrations/001_create_schema.sql uses
 *   auctions.seller_id and auctions.state). Every query here would fail.
 * - NOT AUTHORITATIVE. Do not build features from this file.
 * - CANONICAL implementation lives in src/services/auctionService.js and
 *   src/routes/admin.js. Ownership flows through the canonical chain:
 *   auctions.seller_id → seller_profiles.id → seller_profiles.user_id → users.id
 *   (created_by_user_id is NOT used for ownership).
 */
const db = require('../db');

async function createAuction({ sellerProfileId, createdByUserId, title, description, status, startTime, endTime }) {
  const query = `
    INSERT INTO auctions (
      seller_profile_id,
      created_by_user_id,
      title,
      description,
      status,
      start_time,
      end_time
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING
      id,
      seller_profile_id,
      created_by_user_id,
      title,
      description,
      status,
      start_time,
      end_time,
      created_at,
      updated_at
  `;

  const values = [
    sellerProfileId,
    createdByUserId,
    title,
    description,
    status,
    startTime,
    endTime,
  ];

  const result = await db.query(query, values);
  return result.rows[0];
}

async function getSellerAuctions(userId) {
  const query = `
    SELECT
      id,
      seller_profile_id,
      created_by_user_id,
      title,
      description,
      status,
      start_time,
      end_time,
      created_at,
      updated_at
    FROM auctions
    WHERE created_by_user_id = $1
    ORDER BY created_at DESC
  `;

  const result = await db.query(query, [userId]);
  return result.rows;
}

async function getAuctionById(auctionId, userId) {
  const query = `
    SELECT
      id,
      seller_profile_id,
      created_by_user_id,
      title,
      description,
      status,
      start_time,
      end_time,
      created_at,
      updated_at
    FROM auctions
    WHERE id = $1
      AND created_by_user_id = $2
    LIMIT 1
  `;

  const result = await db.query(query, [auctionId, userId]);
  return result.rows[0] || null;
}

async function updateAuction(auctionId, userId, updates) {
  const allowedFields = {
    title: 'title',
    description: 'description',
    status: 'status',
    startTime: 'start_time',
    endTime: 'end_time',
  };

  const setClauses = [];
  const values = [];
  let paramIndex = 1;

  for (const [inputKey, columnName] of Object.entries(allowedFields)) {
    if (Object.prototype.hasOwnProperty.call(updates, inputKey)) {
      setClauses.push(`${columnName} = $${paramIndex}`);
      values.push(updates[inputKey]);
      paramIndex += 1;
    }
  }

  if (setClauses.length === 0) {
    return null;
  }

  setClauses.push(`updated_at = NOW()`);

  const query = `
    UPDATE auctions
    SET ${setClauses.join(', ')}
    WHERE id = $${paramIndex}
      AND created_by_user_id = $${paramIndex + 1}
    RETURNING
      id,
      seller_profile_id,
      created_by_user_id,
      title,
      description,
      status,
      start_time,
      end_time,
      created_at,
      updated_at
  `;

  values.push(auctionId, userId);

  const result = await db.query(query, values);
  return result.rows[0] || null;
}

module.exports = {
  createAuction,
  getSellerAuctions,
  getAuctionById,
  updateAuction,
};