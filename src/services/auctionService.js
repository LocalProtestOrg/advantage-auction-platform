const db = require('../db/index');
const auditService = require('./auditService');

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

async function publishAuction(auctionId, actorId = null) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const current = await client.query(
      'SELECT id, status FROM auctions WHERE id = $1 FOR UPDATE',
      [auctionId]
    );
    if (!current.rows[0]) {
      throw new Error('Auction not found');
    }
    const { status } = current.rows[0];
    if (status === 'published') {
      throw new Error('Auction is already published');
    }
    if (status === 'closed') {
      throw new Error('Cannot publish a closed auction');
    }

    const result = await client.query(
      `UPDATE auctions
       SET status = 'published',
           start_time = NOW(),
           end_time = NOW() + interval '1 hour',
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [auctionId]
    );

    await client.query(
      `UPDATE lots SET status = 'active' WHERE auction_id = $1 AND status = 'draft'`,
      [auctionId]
    );

    await auditService.logEvent(client, {
      eventType:  'auction.published',
      entityType: 'auction',
      entityId:   auctionId,
      auctionId,
      actorId
    });

    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function closeAuction(auctionId, actorId = null) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Lock auction row and verify it exists and is not already closed
    const auctionRes = await client.query(
      'SELECT id, status FROM auctions WHERE id = $1 FOR UPDATE',
      [auctionId]
    );
    if (!auctionRes.rows[0]) {
      throw new Error('Auction not found');
    }
    const { status } = auctionRes.rows[0];
    if (status === 'closed') {
      throw new Error('Auction is already closed');
    }
    if (status !== 'published') {
      throw new Error('Only published auctions can be closed');
    }

    // Mark auction closed
    await client.query(
      `UPDATE auctions SET status = 'closed', updated_at = now() WHERE id = $1`,
      [auctionId]
    );

    // Lock all lots for this auction before reading bids.
    // This blocks any concurrent createBid calls (which also SELECT lots FOR UPDATE)
    // from slipping a new bid in between the top-bid read and the lot status write.
    const lotsRes = await client.query(
      'SELECT id FROM lots WHERE auction_id = $1 FOR UPDATE',
      [auctionId]
    );

    const results = [];

    for (const lot of lotsRes.rows) {
      // Highest bid: max amount, earliest created_at as tiebreaker
      const bidRes = await client.query(
        `SELECT user_id, amount FROM bids
         WHERE lot_id = $1
         ORDER BY amount DESC, created_at ASC
         LIMIT 1`,
        [lot.id]
      );

      const topBid = bidRes.rows[0];

      if (topBid) {
        const winningCents = Math.round(parseFloat(topBid.amount) * 100);
        await client.query(
          `UPDATE lots
           SET status = 'closed',
               winning_buyer_user_id = $1,
               winning_amount_cents = $2
           WHERE id = $3 AND status != 'closed'`,
          [topBid.user_id, winningCents, lot.id]
        );
        results.push({
          lot_id: lot.id,
          winner_user_id: topBid.user_id,
          winning_amount_cents: winningCents
        });
      } else {
        await client.query(
          `UPDATE lots SET status = 'closed' WHERE id = $1 AND status != 'closed'`,
          [lot.id]
        );
        results.push({
          lot_id: lot.id,
          winner_user_id: null,
          winning_amount_cents: null
        });
      }
    }

    await auditService.logEvent(client, {
      eventType:  'auction.closed',
      entityType: 'auction',
      entityId:   auctionId,
      auctionId,
      actorId,
      metadata: { lots_closed: results.length, results }
    });

    await client.query('COMMIT');

    // Fire-and-forget: cache report data after close is committed.
    // DATA GENERATION ONLY — does not send email, does not send PDF.
    // Final seller report (stats + payout + PDF) is human-gated and sent separately
    // via POST /api/admin/auctions/:auctionId/send-final-report.
    require('./reportingService').generateAuctionReport(auctionId)
      .then(() => console.log(`[reporting] generated auction report for auction_id=${auctionId}`))
      .catch(err => console.error(`[reporting] failed for auction_id=${auctionId}:`, err.message));

    // Fire-and-forget: operational close email to seller (NOT the final payout/stat report).
    // Sends auction total, buyer list, and unpaid item warnings.
    // Email failures must never surface to the caller — auction close is already committed.
    require('./operationalCloseEmailService').sendOperationalCloseEmail(auctionId)
      .catch(err => console.error(`[email] operational close email failed for auction_id=${auctionId}:`, err.message));

    // Fire-and-forget: create seller payout record for tracking.
    // Does NOT move money. Status starts 'pending' and is managed separately by Advantage.
    require('./payoutService').createSellerPayoutRecord(auctionId)
      .then(() => console.log(`[payout] created seller payout record for auction_id=${auctionId}`))
      .catch(err => console.error(`[payout] failed to create seller payout record for auction_id=${auctionId}:`, err.message));

    return {
      auction_id: auctionId,
      lots_closed: results.length,
      results
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  createAuction,
  getSellerAuctions,
  getAuctionById,
  updateAuction,
  deleteAuction,
  publishAuction,
  closeAuction
};