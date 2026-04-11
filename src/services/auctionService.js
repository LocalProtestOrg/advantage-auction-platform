// AuctionService implementation
class AuctionService {
  async createDraft(userId, payload) {
    // Step 1: Validate user is a seller
    const user = await db.query('SELECT role FROM users WHERE id = $1', [userId]);
    if (!user.rows[0] || user.rows[0].role !== 'seller') {
      throw new Error('Unauthorized: User must be a seller');
    }

    // Step 1.5: Fetch seller profile
    const sellerProfile = await db.query('SELECT id FROM seller_profiles WHERE user_id = $1', [userId]);
    if (!sellerProfile.rows[0]) {
      throw new Error('Seller profile not found');
    }

    // Step 2: Validate required payload fields
    if (!payload.title || !payload.timezone) {
      throw new Error('Missing required fields: title, timezone');
    }

    // Step 3: Create auction row with defaults
    const auction = await db.query(`
      INSERT INTO auctions (seller_id, title, description, public_auction_type, auction_terms, city, state, zip, timezone, state, default_starting_bid_cents, increment_ladder, version)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'draft', 100, '[]'::JSONB, 1)
      RETURNING id
    `, [sellerProfile.rows[0].id, payload.title, payload.description || null, payload.public_auction_type || null, payload.auction_terms || null, payload.city || null, payload.state || null, payload.zip || null, payload.timezone]);

    // Step 4: If consignors provided, create consignor records
    if (payload.consignor_ids && Array.isArray(payload.consignor_ids)) {
      for (const consignor of payload.consignor_ids) {
        await db.query(`
          INSERT INTO consignors (auction_id, name, contact_email, contact_phone, notes)
          VALUES ($1, $2, $3, $4, $5)
        `, [auction.rows[0].id, consignor.name || null, consignor.contact_email || null, consignor.contact_phone || null, consignor.notes || null]);
      }
    }

    // Step 5: Return auction id
    return { id: auction.rows[0].id };
  }

  async updateDraft(userId, auctionId, payload) {
    // Step 1: Fetch seller profile
    const sellerProfile = await db.query('SELECT id FROM seller_profiles WHERE user_id = $1', [userId]);
    if (!sellerProfile.rows[0]) {
      throw new Error('Seller profile not found');
    }

    // Step 1.5: Validate user owns the auction and it's in draft state
    const auction = await db.query('SELECT seller_id, state FROM auctions WHERE id = $1', [auctionId]);
    if (!auction.rows[0] || auction.rows[0].seller_id !== sellerProfile.rows[0].id || auction.rows[0].state !== 'draft') {
      throw new Error('Unauthorized or invalid auction state');
    }

    // Step 2: Validate payload fields (simple checks)
    if (payload.pickup_window_start && payload.pickup_window_end) {
      // Basic validation: end after start
      if (new Date(payload.pickup_window_end) <= new Date(payload.pickup_window_start)) {
        throw new Error('Pickup window end must be after start');
      }
    }

    // Step 3: Build update query dynamically
    const fields = [];
    const values = [];
    let paramIndex = 1;
    if (payload.title) { fields.push(`title = $${paramIndex++}`); values.push(payload.title); }
    if (payload.description !== undefined) { fields.push(`description = $${paramIndex++}`); values.push(payload.description); }
    if (payload.auction_terms !== undefined) { fields.push(`auction_terms = $${paramIndex++}`); values.push(payload.auction_terms); }
    if (payload.pickup_window_start !== undefined) { fields.push(`pickup_window_start = $${paramIndex++}`); values.push(payload.pickup_window_start); }
    if (payload.pickup_window_end !== undefined) { fields.push(`pickup_window_end = $${paramIndex++}`); values.push(payload.pickup_window_end); }
    // Add more fields as needed

    if (fields.length === 0) {
      throw new Error('No fields to update');
    }

    // Step 4: Update auction and increment version
    values.push(auctionId);
    await db.query(`
      UPDATE auctions SET ${fields.join(', ')}, version = version + 1, updated_at = now() WHERE id = $${paramIndex}
    `, values);

    // Step 5: Return updated info
    return { id: auctionId, updated_at: new Date() };
  }

  async submitAuction(userId, auctionId, clientVersion) {
    // Step 1: Start transaction
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // Step 1.5: Fetch seller profile
      const sellerProfile = await client.query('SELECT id FROM seller_profiles WHERE user_id = $1', [userId]);
      if (!sellerProfile.rows[0]) {
        throw new Error('Seller profile not found');
      }

      // Step 2: Validate auction ownership, state, and version
      const auction = await client.query('SELECT seller_id, state, version, end_time, pickup_window_start FROM auctions WHERE id = $1 FOR UPDATE', [auctionId]);
      if (!auction.rows[0] || auction.rows[0].seller_id !== sellerProfile.rows[0].id || auction.rows[0].state !== 'draft' || auction.rows[0].version !== clientVersion) {
        throw new Error('Unauthorized, invalid state, or version mismatch');
      }

      // Step 2.5: Validate end_time exists
      if (!auction.rows[0].end_time) {
        throw new Error('Auction end_time is required before submission');
      }

      // Step 3: Validate lots: at least 1, each with size_category and images_count >=1
      const lots = await client.query('SELECT id, size_category, images_count FROM lots WHERE auction_id = $1', [auctionId]);
      if (lots.rows.length === 0) {
        throw new Error('Auction must have at least one lot');
      }
      for (const lot of lots.rows) {
        if (!lot.size_category || lot.images_count < 1) {
          throw new Error('Each lot must have size_category and at least one image');
        }
      }

      // Step 4: Validate exactly 3 featured lots
      const featuredCount = await client.query('SELECT COUNT(*) as count FROM lots WHERE auction_id = $1 AND is_featured = true', [auctionId]);
      if (parseInt(featuredCount.rows[0].count) !== 3) {
        throw new Error('Exactly 3 lots must be featured');
      }

      // Step 5: Validate pickup window (partial: basic check)
      // Note: Full pickup logic not implemented yet
      if (auction.rows[0].pickup_window_start) {
        const endTime = new Date(auction.rows[0].end_time);
        const pickup = new Date(auction.rows[0].pickup_window_start);
        const minPickup = new Date(endTime.getTime() + 36 * 60 * 60 * 1000);
        if (pickup < minPickup) {
          throw new Error('Pickup must start at least 36 hours after auction end');
        }
      }

      // Step 6: Assign starting bids (default if not set)
      await client.query(`
        UPDATE lots SET starting_bid_cents = COALESCE(starting_bid_cents, (SELECT default_starting_bid_cents FROM auctions WHERE id = $1))
        WHERE auction_id = $1 AND starting_bid_cents IS NULL
      `, [auctionId]);

      // Step 7: Compute closes_at sequence (partial: simple sequential)
      // Note: Full stagger logic not implemented yet
      const lotsOrdered = await client.query('SELECT id FROM lots WHERE auction_id = $1 ORDER BY lot_number', [auctionId]);
      let closeTime = new Date(auction.rows[0].end_time);
      for (const lot of lotsOrdered.rows) {
        await client.query('UPDATE lots SET closes_at = $1 WHERE id = $2', [closeTime, lot.id]);
        closeTime = new Date(closeTime.getTime() + 60000); // 1 minute stagger (placeholder)
      }

      // Step 8: Set state to submitted, increment version
      await client.query('UPDATE auctions SET state = \'submitted\', submitted_at = now(), updated_at = now(), version = version + 1 WHERE id = $1', [auctionId]);

      await client.query('COMMIT');
      return { id: auctionId, state: 'submitted' };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async _ensureAdmin(adminId) {
    const user = await db.query('SELECT role FROM users WHERE id = $1', [adminId]);
    if (!user.rows[0] || user.rows[0].role !== 'admin') {
      throw new Error('Unauthorized: Admin only');
    }
  }

  async _validateAuctionForPublish(client, auctionId, auctionRow) {
    if (!auctionRow.end_time) {
      throw new Error('Auction end_time is required before publishing');
    }

    if (auctionRow.pickup_window_start) {
      const endTime = new Date(auctionRow.end_time);
      const pickupStart = new Date(auctionRow.pickup_window_start);
      const minPickup = new Date(endTime.getTime() + 36 * 60 * 60 * 1000);
      if (pickupStart < minPickup) {
        throw new Error('Pickup must start at least 36 hours after auction end');
      }
    }

    const lots = await client.query(
      'SELECT id, size_category, images_count, is_withdrawn, is_featured FROM lots WHERE auction_id = $1',
      [auctionId]
    );

    if (lots.rows.length === 0) {
      throw new Error('Auction must have at least one lot before publishing');
    }

    const activeLots = lots.rows.filter(lot => !lot.is_withdrawn);
    if (activeLots.length === 0) {
      throw new Error('Auction must have at least one active lot before publishing');
    }

    let featuredCount = 0;
    for (const lot of activeLots) {
      if (!lot.size_category) {
        throw new Error('Each lot must have a size_category before publishing');
      }
      if (lot.images_count === null || lot.images_count < 1) {
        throw new Error('Each lot must have at least one image before publishing');
      }
      if (lot.is_featured) {
        featuredCount += 1;
      }
    }

    if (featuredCount !== 3) {
      throw new Error('Exactly 3 featured lots are required before publishing');
    }
  }

  async _logAdminAction(client, adminId, auctionId, action, payload) {
    await client.query(
      `INSERT INTO admin_action_logs (admin_id, auction_id, action, payload)
       VALUES ($1, $2, $3, $4)`,
      [adminId, auctionId, action, payload || {}]
    );
  }

  async _setFeaturedLots(client, auctionId, featuredIds) {
    if (!Array.isArray(featuredIds) || featuredIds.length !== 3) {
      throw new Error('Exactly 3 featured lot ids are required');
    }

    const matched = await client.query(
      'SELECT id FROM lots WHERE auction_id = $1 AND id = ANY($2)',
      [auctionId, featuredIds]
    );
    if (matched.rows.length !== featuredIds.length) {
      throw new Error('One or more featured lot ids do not belong to this auction');
    }

    await client.query(
      `UPDATE lots
       SET is_featured = id = ANY($2)
       WHERE auction_id = $1`,
      [auctionId, featuredIds]
    );
  }

  async publishAuction(adminId, auctionId, options = {}) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      await this._ensureAdmin(adminId);

      const auctionResult = await client.query(
        'SELECT id, state, end_time, pickup_window_start FROM auctions WHERE id = $1 FOR UPDATE',
        [auctionId]
      );

      if (!auctionResult.rows[0]) {
        throw new Error('Auction not found');
      }
      const auction = auctionResult.rows[0];

      if (auction.state !== 'submitted') {
        throw new Error('Only submitted auctions can be published');
      }

      if (options.featuredLotIds !== undefined) {
        await this._setFeaturedLots(client, auctionId, options.featuredLotIds);
      }

      await this._validateAuctionForPublish(client, auctionId, auction);

      await client.query(
        `UPDATE auctions
         SET state = 'published', published_at = now(), updated_at = now(), version = version + 1
         WHERE id = $1`,
        [auctionId]
      );

      await this._logAdminAction(client, adminId, auctionId, 'publish_auction', {
        featured_lot_ids: options.featuredLotIds || null
      });

      await client.query('COMMIT');
      return { id: auctionId, state: 'published' };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async closeAuction(adminId, auctionId) {
    // Admin-only: mark auction as closed and lock winning bidder per lot
    // This is the single point of truth for winner determination
    // Winning bidder and amount are written atomically and immutably
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      await this._ensureAdmin(adminId);

      const auctionRes = await client.query(
        'SELECT id, state, end_time FROM auctions WHERE id = $1 FOR UPDATE',
        [auctionId]
      );
      if (!auctionRes.rows[0]) {
        throw new Error('Auction not found');
      }
      const auction = auctionRes.rows[0];

      if (auction.state !== 'active') {
        throw new Error('Only active auctions can be closed');
      }

      // Get all open lots for this auction
      const lotsRes = await client.query(
        'SELECT id FROM lots WHERE auction_id = $1 AND state = \'open\' FOR UPDATE',
        [auctionId]
      );
      const lots = lotsRes.rows;

      let closedCount = 0;
      const winnersToNotify = []; // Collect winners for post-commit notifications

      // For each lot, determine and lock the winner
      for (const lot of lots) {
        // Get top max bid (respecting tie-break rule: earliest created_at wins)
        const topBidRes = await client.query(
          `SELECT bidder_user_id, max_amount_cents, created_at
           FROM max_bids
           WHERE lot_id = $1
           ORDER BY max_amount_cents DESC, created_at ASC
           LIMIT 2`,
          [lot.id]
        );
        const topBids = topBidRes.rows;

        if (topBids.length === 0) {
          // No bids: withdraw lot
          await client.query(
            'UPDATE lots SET state = \'closed\', is_withdrawn = true, updated_at = now() WHERE id = $1',
            [lot.id]
          );
        } else if (topBids.length === 1) {
          // One bidder: winner at starting bid
          const lotInfoRes = await client.query(
            'SELECT starting_bid_cents FROM lots WHERE id = $1',
            [lot.id]
          );
          const startingBid = lotInfoRes.rows[0].starting_bid_cents || 100;

          await client.query(
            `UPDATE lots
             SET state = 'closed',
                 winning_buyer_user_id = $1,
                 winning_amount_cents = $2,
                 resolved_at = now(),
                 updated_at = now()
             WHERE id = $3`,
            [topBids[0].bidder_user_id, startingBid, lot.id]
          );

          winnersToNotify.push({
            buyerUserId: topBids[0].bidder_user_id,
            lotId: lot.id,
            winningAmount: startingBid
          });
        } else {
          // Multiple bidders: winning price = second-highest max (tie-break already applied)
          const winnerUserId = topBids[0].bidder_user_id;
          const winningPrice = topBids[1].max_amount_cents;

          await client.query(
            `UPDATE lots
             SET state = 'closed',
                 winning_buyer_user_id = $1,
                 winning_amount_cents = $2,
                 resolved_at = now(),
                 updated_at = now()
             WHERE id = $3`,
            [winnerUserId, winningPrice, lot.id]
          );

          winnersToNotify.push({
            buyerUserId: winnerUserId,
            lotId: lot.id,
            winningAmount: winningPrice
          });
        }

        closedCount += 1;
      }

      // Update auction state to closed
      await client.query(
        'UPDATE auctions SET state = \'closed\', updated_at = now() WHERE id = $1',
        [auctionId]
      );

      await this._logAdminAction(client, adminId, auctionId, 'close_auction', {
        closed_lots_count: closedCount,
        timestamp: new Date()
      });

      await client.query('COMMIT');
      client.release();

      // Emit winner notification events asynchronously (fire-and-forget, non-blocking)
      if (winnersToNotify.length > 0) {
        const { emitEvent, EVENTS } = require('./eventEmitter');
        for (const winner of winnersToNotify) {
          emitEvent(EVENTS.AUCTION_WON, {
            buyerUserId: winner.buyerUserId,
            auctionId,
            lotId: winner.lotId,
            winningAmount: winner.winningAmount
          });
        }
      }

      return {
        auction_id: auctionId,
        closed_lot_count: closedCount
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      if (!client._released) {
        client.release();
      }
    }
  }
}

module.exports = new AuctionService();
