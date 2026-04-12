const db = require('../db/index');

async function createAuction(data) {
  console.log('RUNNING CREATE AUCTION SERVICE');

  const {
    sellerProfileId,
    createdByUserId,
    title,
    description,
    status,
    startTime,
    endTime
  } = data;

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
    RETURNING *;
  `;

  const values = [
    sellerProfileId,
    createdByUserId,
    title,
    description || null,
    status || 'draft',
    startTime || null,
    endTime || null
  ];

  const result = await db.query(query, values);
  return result.rows[0];
}


// Update auction (only allowed fields, enforce ownership)
async function updateAuction(auctionId, userId, updates) {
  const allowed = ['title', 'description', 'status', 'start_time', 'end_time'];
  const fields = [];
  const values = [];
  let idx = 1;

  for (const key of allowed) {
    if (updates[key] !== undefined) {
      fields.push(`${key} = $${idx++}`);
      values.push(updates[key]);
    }
  }
  if (fields.length === 0) return null;

  values.push(new Date()); // updated_at
  fields.push(`updated_at = $${idx++}`);

  values.push(auctionId, userId);

  const query = `
    UPDATE auctions
    SET ${fields.join(', ')}
    WHERE id = $${idx++} AND created_by_user_id = $${idx}
    RETURNING *
  `;
  const result = await db.query(query, values);
  return result.rows[0] || null;
}

// Delete auction (enforce ownership)
async function deleteAuction(auctionId, userId) {
  const query = `
    DELETE FROM auctions
    WHERE id = $1 AND created_by_user_id = $2
    RETURNING *
  `;
  const result = await db.query(query, [auctionId, userId]);
  return result.rows[0] || null;
}


// Get all auctions for a seller (by created_by_user_id)
async function getSellerAuctions(userId) {
  const query = `
    SELECT *
    FROM auctions
    WHERE created_by_user_id = $1
    ORDER BY created_at DESC
  `;
  const result = await db.query(query, [userId]);
  return result.rows;
}


// Get a single auction by id and owner
async function getAuctionById(auctionId, userId) {
  const query = `
    SELECT *
    FROM auctions
    WHERE id = $1 AND created_by_user_id = $2
    LIMIT 1
  `;
  const result = await db.query(query, [auctionId, userId]);
  return result.rows[0] || null;
}

module.exports = {
  createAuction,
  getSellerAuctions,
  getAuctionById,
  updateAuction,
  deleteAuction
};