const db = require('../db/index');

// Create a bid (with transaction)
async function createBid(lotId, userId, { amount, maxBid }) {
  console.log('CREATE BID START');
  console.log('lotId:', lotId);
  console.log('userId:', userId);
  console.log('amount:', amount);
  console.log('maxBid:', maxBid);

  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const lotRes = await client.query(
      'SELECT * FROM lots WHERE id = $1 FOR UPDATE',
      [lotId]
    );

    const lot = lotRes.rows[0];

    if (!lot) {
      throw new Error('Lot not found');
    }

    console.log('lot current_price:', lot.current_price);
    console.log('lot bid_increment:', lot.bid_increment);
    console.log('lot status:', lot.status);

    // TEMP: allow draft/open while testing
    if (!['draft', 'open'].includes(lot.status)) {
      throw new Error('Bidding not allowed on this lot');
    }

    const minBid = Number(lot.current_price) + Number(lot.bid_increment);
    console.log('minBid:', minBid);

    if (Number(amount) < minBid) {
      throw new Error(`Bid must be at least ${minBid}`);
    }

    console.log('about to insert bid');

    const insertResult = await client.query(
      `INSERT INTO bids (lot_id, user_id, amount, max_bid)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [lotId, userId, amount, maxBid || null]
    );

    console.log('insert result:', insertResult.rows[0]);

    const updateResult = await client.query(
      `UPDATE lots
       SET current_price = $1
       WHERE id = $2`,
      [amount, lotId]
    );

    console.log('update rowCount:', updateResult.rowCount);
    console.log('COMMITTING');

    await client.query('COMMIT');

    return insertResult.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('CREATE BID ERROR:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Get all bids for a lot
async function getBidsByLot(lotId) {
  const res = await db.query(
    `SELECT * FROM bids WHERE lot_id = $1 ORDER BY created_at DESC`,
    [lotId]
  );

  return res.rows;
}

module.exports = {
  createBid,
  getBidsByLot
};

