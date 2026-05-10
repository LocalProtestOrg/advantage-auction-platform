const db = require('../db/index');

// Create lot (seller-owned, verifies auction ownership via seller_profiles)
async function createLot(auctionId, userId, data) {
  const ownershipCheck = await db.query(
    `SELECT a.id FROM auctions a
     JOIN seller_profiles sp ON sp.id = a.seller_id
     WHERE a.id = $1 AND sp.user_id = $2`,
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
    pickupCategory,
    category
  } = data;

  const result = await db.query(
    `INSERT INTO lots (
       auction_id,
       title,
       description,
       starting_bid_cents,
       bid_increment_cents,
       pickup_category,
       category,
       state
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'open')
     RETURNING *`,
    [
      auctionId,
      title,
      description || null,
      startingPrice ? Math.round(Number(startingPrice) * 100) : 100,
      bidIncrement  ? Math.round(Number(bidIncrement)  * 100) : 500,
      pickupCategory || null,
      category || null
    ]
  );
  return result.rows[0];
}

// Get lots for an auction
async function getLotsByAuction(auctionId) {
  const result = await db.query(
    `SELECT * FROM lots WHERE auction_id = $1 ORDER BY lot_number ASC NULLS LAST, created_at ASC`,
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

// Update lot (verifies auction ownership via seller_profiles)
async function updateLot(lotId, userId, updates) {
  const check = await db.query(
    `SELECT l.id FROM lots l
     JOIN auctions a ON l.auction_id = a.id
     JOIN seller_profiles sp ON sp.id = a.seller_id
     WHERE l.id = $1 AND sp.user_id = $2`,
    [lotId, userId]
  );

  if (check.rows.length === 0) {
    throw new Error('Unauthorized');
  }

  const fields = [];
  const values = [];
  let index = 1;

  const map = {
    title:         'title',
    description:   'description',
    startingPrice: 'starting_bid_cents',
    bidIncrement:  'bid_increment_cents',
    pickupCategory:'pickup_category',
    state:         'state'
  };

  for (const key in map) {
    if (updates[key] !== undefined) {
      fields.push(`${map[key]} = $${index}`);
      if (key === 'startingPrice' || key === 'bidIncrement') {
        values.push(Math.round(Number(updates[key]) * 100));
      } else {
        values.push(updates[key]);
      }
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

// Delete lot (verifies auction ownership via seller_profiles)
async function deleteLot(lotId, userId) {
  const check = await db.query(
    `SELECT l.id FROM lots l
     JOIN auctions a ON l.auction_id = a.id
     JOIN seller_profiles sp ON sp.id = a.seller_id
     WHERE l.id = $1 AND sp.user_id = $2`,
    [lotId, userId]
  );

  if (check.rows.length === 0) {
    throw new Error('Unauthorized');
  }

  const result = await db.query(
    `DELETE FROM lots WHERE id = $1 RETURNING *`,
    [lotId]
  );

  return result.rows[0];
}

// Admin-only: create a lot for any auction without ownership check
async function adminCreateLot(auctionId, data) {
  const { title, description, startingPrice } = data;

  const result = await db.query(
    `INSERT INTO lots (
       auction_id, title, description,
       starting_bid_cents, bid_increment_cents,
       pickup_category, state
     )
     VALUES ($1, $2, $3, $4, 500, null, 'open')
     RETURNING *`,
    [
      auctionId,
      title,
      description || null,
      startingPrice ? Math.round(Number(startingPrice) * 100) : 100
    ]
  );

  return result.rows[0];
}

module.exports = {
  createLot,
  adminCreateLot,
  getLotsByAuction,
  getLotById,
  updateLot,
  deleteLot
};
