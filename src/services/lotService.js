const db = require('../db/index');

// Create lot
async function createLot(auctionId, userId, data) {
  // 1. Verify auction ownership
  const ownershipCheck = await db.query(
    `SELECT id FROM auctions WHERE id = $1 AND created_by_user_id = $2`,
    [auctionId, userId]
  );

  if (ownershipCheck.rows.length === 0) {
    throw new Error('Unauthorized or auction not found');
  }

  const {
    title,
    description,
    startingPrice,
    bidIncrement,
    position,
    pickupCategory
  } = data;

  const query = `
    INSERT INTO lots (
      auction_id,
      title,
      description,
      starting_price,
      current_price,
      bid_increment,
      position,
      pickup_category,
      status
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    RETURNING *;
  `;

  const values = [
    auctionId,
    title,
    description || null,
    startingPrice || 0,
    startingPrice || 0,
    bidIncrement || 1,
    position || 0,
    pickupCategory || 'A',
    'draft'
  ];

  const result = await db.query(query, values);
  return result.rows[0];
}

// Get lots for an auction
async function getLotsByAuction(auctionId) {
  const result = await db.query(
    `SELECT * FROM lots WHERE auction_id = $1 ORDER BY position ASC`,
    [auctionId]
  );

  return result.rows;
}

// Get single lot
async function getLotById(lotId) {
  const result = await db.query(
    `SELECT * FROM lots WHERE id = $1 LIMIT 1`,
    [lotId]
  );

  return result.rows[0] || null;
}

// Update lot
async function updateLot(lotId, userId, updates) {
  // Verify ownership through auction
  const check = await db.query(`
    SELECT l.id FROM lots l
    JOIN auctions a ON l.auction_id = a.id
    WHERE l.id = $1 AND a.created_by_user_id = $2
  `, [lotId, userId]);

  if (check.rows.length === 0) {
    throw new Error('Unauthorized');
  }

  const fields = [];
  const values = [];
  let index = 1;

  const map = {
    title: 'title',
    description: 'description',
    startingPrice: 'starting_price',
    bidIncrement: 'bid_increment',
    position: 'position',
    pickupCategory: 'pickup_category',
    status: 'status'
  };

  for (const key in map) {
    if (updates[key] !== undefined) {
      fields.push(`${map[key]} = $${index}`);
      values.push(updates[key]);
      index++;
    }
  }

  if (fields.length === 0) {
    throw new Error('No valid fields');
  }

  fields.push(`updated_at = NOW()`);

  values.push(lotId);

  const result = await db.query(
    `UPDATE lots SET ${fields.join(', ')} WHERE id = $${index} RETURNING *`,
    values
  );

  return result.rows[0];
}

// Delete lot
async function deleteLot(lotId, userId) {
  const check = await db.query(`
    SELECT l.id FROM lots l
    JOIN auctions a ON l.auction_id = a.id
    WHERE l.id = $1 AND a.created_by_user_id = $2
  `, [lotId, userId]);

  if (check.rows.length === 0) {
    throw new Error('Unauthorized');
  }

  const result = await db.query(
    `DELETE FROM lots WHERE id = $1 RETURNING *`,
    [lotId]
  );

  return result.rows[0];
}

module.exports = {
  createLot,
  getLotsByAuction,
  getLotById,
  updateLot,
  deleteLot
};
