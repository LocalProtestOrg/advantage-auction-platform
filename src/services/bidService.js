// BidService implementation
class BidService {
  _resolveIncrement(currentAmount, ladder) {
    const defaultIncrement = 100;
    if (!Array.isArray(ladder) || ladder.length === 0) {
      return defaultIncrement;
    }

    const steps = ladder
      .map(step => {
        if (Array.isArray(step) && step.length >= 2) {
          return { threshold: Number(step[0]), increment: Number(step[1]) };
        }
        if (step && typeof step === 'object' && 'threshold' in step && 'increment' in step) {
          return { threshold: Number(step.threshold), increment: Number(step.increment) };
        }
        return null;
      })
      .filter(Boolean)
      .sort((a, b) => a.threshold - b.threshold);

    let result = defaultIncrement;
    for (const step of steps) {
      if (currentAmount >= step.threshold) {
        result = step.increment;
      } else {
        break;
      }
    }
    return result;
  }

  async _ensureRegisteredBuyer(client, userId, auctionId) {
    const buyer = await client.query(
      'SELECT paddle_number FROM auction_buyers WHERE auction_id = $1 AND user_id = $2',
      [auctionId, userId]
    );
    if (!buyer.rows[0]) {
      throw new Error('Unauthorized: Buyer must be registered for this auction');
    }
    return buyer.rows[0].paddle_number;
  }

  async _ensureCardVerified(client, userId) {
    const card = await client.query(
      'SELECT status FROM card_verifications WHERE user_id = $1 ORDER BY attempted_at DESC LIMIT 1',
      [userId]
    );
    if (!card.rows[0] || card.rows[0].status !== 'verified') {
      throw new Error('Card verification required');
    }
  }

  async getTopMaxBids(client, lotId) {
    // Order by max_amount_cents DESC, then by created_at ASC (tie-break: earliest wins)
    const result = await client.query(
      `SELECT bidder_user_id, max_amount_cents, created_at
       FROM max_bids
       WHERE lot_id = $1
       ORDER BY max_amount_cents DESC, created_at ASC`,
      [lotId]
    );
    return result.rows;
  }

  calculateVisibleBid(topMaxBids, startingBid, increment) {
    // Public visible bid calculation:
    // - No bids: 0
    // - One bidder: starting bid
    // - Multiple: second-highest max + increment, capped by highest max
    if (topMaxBids.length === 0) {
      return 0;
    }
    if (topMaxBids.length === 1) {
      return startingBid;
    }
    const winnerMax = topMaxBids[0].max_amount_cents;
    const secondMax = topMaxBids[1].max_amount_cents;
    return Math.min(winnerMax, secondMax + increment);
  }

  determineWinningBidder(topMaxBids) {
    return topMaxBids.length > 0 ? topMaxBids[0].bidder_user_id : null;
  }

  async storeOrUpdateMaxBid(client, lotId, bidderUserId, maxAmount) {
    // Store or update bidder's max bid for this lot
    // UNIQUE constraint ensures one max_bid per (lot, bidder)
    await client.query(
      `INSERT INTO max_bids (lot_id, bidder_user_id, max_amount_cents, created_at, updated_at)
       VALUES ($1, $2, $3, now(), now())
       ON CONFLICT (lot_id, bidder_user_id)
       DO UPDATE SET max_amount_cents = EXCLUDED.max_amount_cents, updated_at = now()`,
      [lotId, bidderUserId, maxAmount]
    );
  }

  async storeBidEvent(client, lotId, auctionId, bidderUserId, submittedMax, visibleBid, paddleNumber, isProxy) {
    // Store bid event for audit trail
    // amount_cents = submitted max (admin/bidder only visibility)
    // visible_bid_cents = public-safe bid displayed to all (calculated from proxy logic)
    // is_proxy indicates bidder submitted more than the visible bid
    await client.query(
      `INSERT INTO bids (lot_id, auction_id, bidder_user_id, amount_cents, timestamp, is_proxy, paddle_number)
       VALUES ($1, $2, $3, $4, now(), $5, $6)`,
      [lotId, auctionId, bidderUserId, submittedMax, isProxy, paddleNumber]
    );
  }

  async placeBid(userId, auctionId, lotId, amountCents) {
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new Error('Bid amount must be a positive integer');
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const paddleNumber = await this._ensureRegisteredBuyer(client, userId, auctionId);
      await this._ensureCardVerified(client, userId);

      const auctionRes = await client.query(
        'SELECT state, increment_ladder, default_starting_bid_cents FROM auctions WHERE id = $1 FOR UPDATE',
        [auctionId]
      );
      if (!auctionRes.rows[0]) {
        throw new Error('Auction not found');
      }
      const auction = auctionRes.rows[0];
      if (auction.state !== 'active') {
        throw new Error('Bids are only accepted for active auctions');
      }

      const lotRes = await client.query(
        'SELECT id, state, is_withdrawn, starting_bid_cents, current_bid_cents FROM lots WHERE id = $1 AND auction_id = $2 FOR UPDATE',
        [lotId, auctionId]
      );
      if (!lotRes.rows[0]) {
        throw new Error('Lot not found');
      }
      const lot = lotRes.rows[0];
      if (lot.is_withdrawn || lot.state !== 'open') {
        throw new Error('Lot is not available for bidding');
      }

      const startingBid = lot.starting_bid_cents || auction.default_starting_bid_cents || 100;
      const topMaxBids = await this.getTopMaxBids(client, lotId);
      const increment = this._resolveIncrement(lot.current_bid_cents || 0, auction.increment_ladder || []);
      const currentVisible = this.calculateVisibleBid(topMaxBids, startingBid, increment);
      const winningBidder = this.determineWinningBidder(topMaxBids);

      let newVisible;
      let isProxy = false;

      if (topMaxBids.length === 0) {
        // First bid
        if (amountCents < startingBid) {
          throw new Error(`Bid must be at least ${startingBid} cents`);
        }
        newVisible = startingBid;
        isProxy = amountCents > startingBid;
      } else {
        const minBid = currentVisible + increment;
        if (amountCents < minBid) {
          throw new Error(`Bid must be at least ${minBid} cents`);
        }

        if (winningBidder === userId) {
          // Current winner raising their own max bid
          if (amountCents <= topMaxBids[0].max_amount_cents) {
            throw new Error('New max bid must exceed your existing max bid');
          }
          // Visible bid stays same since winner is unchanged
          newVisible = currentVisible;
          isProxy = true;
        } else {
          // Competing bidder challenging current winner
          const winnerMax = topMaxBids[0].max_amount_cents;
          if (amountCents > winnerMax) {
            // New bidder becomes winner
            newVisible = Math.min(amountCents, winnerMax + increment);
          } else {
            // New bidder does not overtake winner; recalculate visible from second position
            const secondMax = topMaxBids.length > 1 ? topMaxBids[1].max_amount_cents : 0;
            const competingMax = Math.max(secondMax, amountCents);
            newVisible = Math.min(winnerMax, competingMax + increment);
          }
          isProxy = amountCents > newVisible;
        }
      }

      // Store max bid intent in max_bids table
      await this.storeOrUpdateMaxBid(client, lotId, userId, amountCents);

      // Store bid event with public-safe visible bid for history
      await this.storeBidEvent(client, lotId, auctionId, userId, amountCents, newVisible, paddleNumber, isProxy);

      // Update lot's current price (public display)
      // bid_count incremented for each bid event (counts all placement attempts, not unique bidders)
      await client.query(
        'UPDATE lots SET current_bid_cents = $1, bid_count = COALESCE(bid_count, 0) + 1 WHERE id = $2',
        [newVisible, lotId]
      );

      await client.query('COMMIT');
      return {
        auction_id: auctionId,
        lot_id: lotId,
        amount_cents: newVisible,
        is_proxy: isProxy,
        paddle_number: paddleNumber
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getPublicBidHistory(auctionId, lotId) {
    // Public bid history DOES NOT expose submitted max bids (amount_cents)
    // Only shows is_proxy flag and paddle number
    // Caller uses this to display bid progression without revealing max bid amounts
    const history = await db.query(
      `SELECT paddle_number, timestamp, is_proxy
       FROM bids
       WHERE auction_id = $1 AND lot_id = $2
       ORDER BY timestamp ASC`,
      [auctionId, lotId]
    );

    return history.rows.map(row => ({
      paddle_number: row.paddle_number,
      timestamp: row.timestamp,
      is_proxy: row.is_proxy
    }));
  }

  async getBidHistory(auctionId, lotId) {
    return this.getPublicBidHistory(auctionId, lotId);
  }

  // TODO: Implement soft-close extension logic (extend lot close time by 2 minutes if bid placed within last 2 minutes of closes_at)
  // TODO: Implement outbid notifications
}

module.exports = new BidService();

