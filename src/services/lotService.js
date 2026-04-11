// LotService implementation
class LotService {
  async createLot(userId, auctionId, payload) {
    // Step 1: Validate user owns auction and auction is in draft state
    const sellerProfile = await db.query('SELECT id FROM seller_profiles WHERE user_id = $1', [userId]);
    if (!sellerProfile.rows[0]) {
      throw new Error('Seller profile not found');
    }

    const auction = await db.query('SELECT seller_id, state FROM auctions WHERE id = $1', [auctionId]);
    if (!auction.rows[0] || auction.rows[0].seller_id !== sellerProfile.rows[0].id || auction.rows[0].state !== 'draft') {
      throw new Error('Unauthorized or auction not in draft state');
    }

    // Step 2: Validate required fields
    if (!payload.size_category) {
      throw new Error('size_category is required');
    }

    // Step 3: Assign unique lot_number
    const maxLot = await db.query('SELECT MAX(lot_number) as max FROM lots WHERE auction_id = $1', [auctionId]);
    const lotNumber = (maxLot.rows[0].max || 0) + 1;

    // Step 4: Create lot row with defaults
    const lot = await db.query(`
      INSERT INTO lots (auction_id, lot_number, title, description, size_category, dimensions, starting_bid_cents, reserve_price_cents, is_featured, images_count, version)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, 1)
      RETURNING id
    `, [
      auctionId,
      lotNumber,
      payload.title || null,
      payload.description || null,
      payload.size_category,
      payload.dimensions || null,
      payload.starting_bid_cents || null,
      payload.reserve_price_cents || null,
      payload.is_featured || false
    ]);

    // Step 5: Return lot id and number
    return { id: lot.rows[0].id, lot_number: lotNumber };
  }

  async updateLot(userId, auctionId, lotId, payload) {
    // Step 1: Validate user owns auction and auction is in draft state
    const sellerProfile = await db.query('SELECT id FROM seller_profiles WHERE user_id = $1', [userId]);
    if (!sellerProfile.rows[0]) {
      throw new Error('Seller profile not found');
    }

    const auction = await db.query('SELECT seller_id, state FROM auctions WHERE id = $1', [auctionId]);
    if (!auction.rows[0] || auction.rows[0].seller_id !== sellerProfile.rows[0].id || auction.rows[0].state !== 'draft') {
      throw new Error('Unauthorized or auction not in draft state');
    }

    // Step 2: Validate lot exists and not withdrawn
    const lotCheck = await db.query('SELECT id, is_withdrawn FROM lots WHERE id = $1 AND auction_id = $2', [lotId, auctionId]);
    if (!lotCheck.rows[0] || lotCheck.rows[0].is_withdrawn) {
      throw new Error('Lot not found or already withdrawn');
    }

    // Step 3: Validate payload fields
    if (payload.size_category !== undefined && !payload.size_category) {
      throw new Error('size_category cannot be empty if provided');
    }

    // Step 4: Build update query dynamically
    const fields = [];
    const values = [];
    let paramIndex = 1;
    if (payload.title !== undefined) { fields.push(`title = $${paramIndex++}`); values.push(payload.title); }
    if (payload.description !== undefined) { fields.push(`description = $${paramIndex++}`); values.push(payload.description); }
    if (payload.size_category !== undefined) { fields.push(`size_category = $${paramIndex++}`); values.push(payload.size_category); }
    if (payload.dimensions !== undefined) { fields.push(`dimensions = $${paramIndex++}`); values.push(payload.dimensions); }
    if (payload.starting_bid_cents !== undefined) { fields.push(`starting_bid_cents = $${paramIndex++}`); values.push(payload.starting_bid_cents); }
    if (payload.reserve_price_cents !== undefined) { fields.push(`reserve_price_cents = $${paramIndex++}`); values.push(payload.reserve_price_cents); }
    if (payload.is_featured !== undefined) { fields.push(`is_featured = $${paramIndex++}`); values.push(payload.is_featured); }

    if (fields.length === 0) {
      throw new Error('No fields to update');
    }

    // Step 5: Update lot and increment version
    values.push(lotId);
    await db.query(`
      UPDATE lots SET ${fields.join(', ')}, version = version + 1, updated_at = now() WHERE id = $${paramIndex}
    `, values);

    // Step 6: Return updated info
    return { id: lotId, updated_at: new Date() };
  }

  async withdrawLot(userId, auctionId, lotId) {
    // Step 1: Validate user owns auction and auction is in draft state
    const sellerProfile = await db.query('SELECT id FROM seller_profiles WHERE user_id = $1', [userId]);
    if (!sellerProfile.rows[0]) {
      throw new Error('Seller profile not found');
    }

    const auction = await db.query('SELECT seller_id, state FROM auctions WHERE id = $1', [auctionId]);
    if (!auction.rows[0] || auction.rows[0].seller_id !== sellerProfile.rows[0].id || auction.rows[0].state !== 'draft') {
      throw new Error('Unauthorized or auction not in draft state');
    }

    // Step 2: Validate lot exists, not withdrawn, and get featured count
    const lot = await db.query(`
      SELECT is_featured, is_withdrawn, (SELECT COUNT(*) FROM lots WHERE auction_id = $1 AND is_featured = true AND id != $2) as featured_count
      FROM lots WHERE id = $2 AND auction_id = $1
    `, [auctionId, lotId]);
    if (!lot.rows[0] || lot.rows[0].is_withdrawn) {
      throw new Error('Lot not found or already withdrawn');
    }

    // Step 3: Check featured constraint: if withdrawing featured lot, ensure at least 3 featured remain
    if (lot.rows[0].is_featured && parseInt(lot.rows[0].featured_count) < 3) {
      throw new Error('Cannot withdraw featured lot: would leave less than 3 featured lots');
    }

    // Step 4: Withdraw lot
    await db.query('UPDATE lots SET is_withdrawn = true, updated_at = now(), version = version + 1 WHERE id = $1', [lotId]);

    // Step 5: Return confirmation
    return { id: lotId, withdrawn: true };
  }

  async computeClosesSequence(auctionId) {
    // TODO: For each lot, set closes_at based on sequential stagger from auction start, persist closes_at
    throw new Error('Not implemented');
  }
}

module.exports = new LotService();
