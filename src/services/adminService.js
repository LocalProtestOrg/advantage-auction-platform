// AdminService implementation
class AdminService {
  async _ensureAdmin(adminId) {
    const user = await db.query('SELECT role FROM users WHERE id = $1', [adminId]);
    if (!user.rows[0] || user.rows[0].role !== 'admin') {
      throw new Error('Unauthorized: Admin only');
    }
  }

  async _logAdminAction(adminId, auctionId, lotId, action, payload) {
    await db.query(
      `INSERT INTO admin_action_logs (admin_id, auction_id, lot_id, action, payload)
       VALUES ($1, $2, $3, $4, $5)`,
      [adminId, auctionId, lotId, action, payload || {}]
    );
  }

  async overrideFeatured(adminId, auctionId, featuredIds) {
    await this._ensureAdmin(adminId);

    if (!Array.isArray(featuredIds) || featuredIds.length !== 3) {
      throw new Error('Exactly 3 featured lot ids are required');
    }

    const auction = await db.query('SELECT id FROM auctions WHERE id = $1', [auctionId]);
    if (!auction.rows[0]) {
      throw new Error('Auction not found');
    }

    const matched = await db.query(
      'SELECT id FROM lots WHERE auction_id = $1 AND id = ANY($2)',
      [auctionId, featuredIds]
    );
    if (matched.rows.length !== featuredIds.length) {
      throw new Error('One or more featured lot ids do not belong to this auction');
    }

    await db.query(
      `UPDATE lots
       SET is_featured = id = ANY($2)
       WHERE auction_id = $1`,
      [auctionId, featuredIds]
    );

    await this._logAdminAction(adminId, auctionId, null, 'override_featured_lots', {
      featured_lot_ids: featuredIds
    });

    return { auction_id: auctionId, featured_lot_ids: featuredIds };
  }

  async editAuction(adminId, auctionId, payload) {
    await this._ensureAdmin(adminId);

    const auction = await db.query('SELECT id FROM auctions WHERE id = $1', [auctionId]);
    if (!auction.rows[0]) {
      throw new Error('Auction not found');
    }

    const allowedFields = [
      'title',
      'description',
      'public_auction_type',
      'auction_terms',
      'city',
      'state',
      'zip',
      'timezone',
      'start_time',
      'end_time',
      'pickup_window_start',
      'pickup_window_end',
      'marketing_selection',
      'admin_notes'
    ];

    const fields = [];
    const values = [];
    let paramIndex = 1;

    for (const key of allowedFields) {
      if (payload[key] !== undefined) {
        fields.push(`${key} = $${paramIndex++}`);
        values.push(payload[key]);
      }
    }

    if (payload.featured_lot_ids !== undefined) {
      await this.overrideFeatured(adminId, auctionId, payload.featured_lot_ids);
    }

    if (fields.length > 0) {
      values.push(auctionId);
      await db.query(
        `UPDATE auctions SET ${fields.join(', ')}, version = version + 1, updated_at = now() WHERE id = $${paramIndex}`,
        values
      );
    }

    await this._logAdminAction(adminId, auctionId, null, 'admin_edit_auction', {
      fields: Object.keys(payload).filter(key => allowedFields.includes(key)),
      featured_lot_ids: payload.featured_lot_ids
    });

    return { id: auctionId, updated_at: new Date() };
  }

  async setSellerCapabilities(adminId, sellerId, payload) {
    await this._ensureAdmin(adminId);

    const seller = await db.query('SELECT capabilities FROM seller_profiles WHERE id = $1', [sellerId]);
    if (!seller.rows[0]) {
      throw new Error('Seller profile not found');
    }

    const capabilities = { ...(seller.rows[0].capabilities || {}) };
    let hasUpdate = false;

    if (payload.shipping_enabled !== undefined) {
      capabilities.shipping_enabled = Boolean(payload.shipping_enabled);
      hasUpdate = true;
    }
    if (payload.reserve_enabled !== undefined) {
      capabilities.reserve_enabled = Boolean(payload.reserve_enabled);
      hasUpdate = true;
    }

    if (!hasUpdate) {
      throw new Error('No capability flags provided');
    }

    await db.query(
      'UPDATE seller_profiles SET capabilities = $1 WHERE id = $2',
      [capabilities, sellerId]
    );

    await this._logAdminAction(adminId, null, null, 'set_seller_capabilities', {
      seller_id: sellerId,
      capabilities
    });

    return { seller_id: sellerId, capabilities };
  }

  async regenPickupSchedule(adminId, auctionId) {
    throw new Error('Not implemented');
  }
}

module.exports = new AdminService();
