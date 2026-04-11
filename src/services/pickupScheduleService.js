// PickupScheduleService implementation
class PickupScheduleService {
  async _ensureAdminRole(client, adminId) {
    const user = await client.query('SELECT role FROM users WHERE id = $1', [adminId]);
    if (!user.rows[0] || user.rows[0].role !== 'admin') {
      throw new Error('Unauthorized: Admin only');
    }
  }

  async _ensurePaymentPaid(client, lotId, buyerUserId) {
    // Guard: Only paid lots can have pickup assignments
    const payment = await client.query(
      `SELECT status FROM payments
       WHERE lot_id = $1 AND buyer_user_id = $2 AND status = 'paid'
       LIMIT 1`,
      [lotId, buyerUserId]
    );
    if (!payment.rows[0]) {
      throw new Error('Pickup available only for paid lots');
    }
  }

  generateSlotDates(windowStart, windowEnd, categoryCount) {
    // Divide pickup window into slots for each category (A, B, C)
    // Returns array of [slotStart, slotEnd] for each category
    const start = new Date(windowStart);
    const end = new Date(windowEnd);
    const totalMs = end - start;
    const slotDurationMs = totalMs / categoryCount;

    const slots = [];
    for (let i = 0; i < categoryCount; i++) {
      const slotStart = new Date(start.getTime() + i * slotDurationMs);
      const slotEnd = new Date(slotStart.getTime() + slotDurationMs);
      slots.push({ start: slotStart, end: slotEnd });
    }
    return slots;
  }

  async generateSchedule(adminId, auctionId) {
    // After auction closes, generate pickup windows for all paid lots
    // Groups by size_category (A, B, C) and assigns sequential time slots
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      await this._ensureAdminRole(client, adminId);

      const auctionRes = await client.query(
        'SELECT id, pickup_window_start, pickup_window_end FROM auctions WHERE id = $1',
        [auctionId]
      );
      if (!auctionRes.rows[0]) {
        throw new Error('Auction not found');
      }
      const auction = auctionRes.rows[0];

      if (!auction.pickup_window_start || !auction.pickup_window_end) {
        throw new Error('Auction must have pickup window defined');
      }

      // Get all closed lots with winners for this auction
      const lotsRes = await client.query(
        `SELECT id, size_category, winning_buyer_user_id
         FROM lots
         WHERE auction_id = $1 AND state = 'closed' AND winning_buyer_user_id IS NOT NULL
         ORDER BY size_category, id`,
        [auctionId]
      );
      const lots = lotsRes.rows;

      if (lots.length === 0) {
        throw new Error('No sold lots to generate pickup schedule');
      }

      // Group lots by size_category
      const byCat = { A: [], B: [], C: [] };
      for (const lot of lots) {
        if (lot.size_category && byCat[lot.size_category]) {
          byCat[lot.size_category].push(lot);
        }
      }

      // Generate slots for each category (order: A, B, C)
      const categories = ['A', 'B', 'C'];
      const usedCategories = categories.filter(cat => byCat[cat].length > 0);
      const slots = this.generateSlotDates(
        auction.pickup_window_start,
        auction.pickup_window_end,
        usedCategories.length
      );

      // Build schedule JSON
      const schedule = {};
      const assignments = [];
      usedCategories.forEach((cat, idx) => {
        const slot = slots[idx];
        schedule[cat] = {
          slot_start: slot.start,
          slot_end: slot.end,
          lot_count: byCat[cat].length
        };

        // Queue assignments
        for (const lot of byCat[cat]) {
          assignments.push({
            lotId: lot.id,
            buyerUserId: lot.winning_buyer_user_id,
            slotStart: slot.start,
            slotEnd: slot.end
          });
        }
      });

      // Create pickup_schedule record
      const scheduleRes = await client.query(
        `INSERT INTO pickup_schedules (auction_id, schedule, generated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (auction_id)
         DO UPDATE SET schedule = EXCLUDED.schedule, generated_at = now()
         RETURNING id`,
        [auctionId, JSON.stringify(schedule)]
      );
      const scheduleId = scheduleRes.rows[0].id;

      // Create pickup_assignments for each lot
      for (const assignment of assignments) {
        // Verify payment is paid  before assigning
        const payment = await client.query(
          `SELECT id FROM payments
           WHERE lot_id = $1 AND buyer_user_id = $2 AND status = 'paid'`,
          [assignment.lotId, assignment.buyerUserId]
        );
        if (payment.rows[0]) {
          await client.query(
            `INSERT INTO pickup_assignments (pickup_schedule_id, lot_id, buyer_user_id, slot_start, slot_end)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT DO NOTHING`,
            [scheduleId, assignment.lotId, assignment.buyerUserId, assignment.slotStart, assignment.slotEnd]
          );
        }
      }

      await client.query('COMMIT');
      return {
        pickup_schedule_id: scheduleId,
        auction_id: auctionId,
        schedule,
        assignment_count: assignments.length
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async assignPickupSlot(adminId, pickupScheduleId, lotId, buyerUserId, slotStart, slotEnd) {
    // Admin tool to manually assign or override pickup slot
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      await this._ensureAdminRole(client, adminId);
      await this._ensurePaymentPaid(client, lotId, buyerUserId);

      const scheduleRes = await client.query(
        'SELECT id FROM pickup_schedules WHERE id = $1',
        [pickupScheduleId]
      );
      if (!scheduleRes.rows[0]) {
        throw new Error('Pickup schedule not found');
      }

      // Create or update pickup assignment
      await client.query(
        `INSERT INTO pickup_assignments (pickup_schedule_id, lot_id, buyer_user_id, slot_start, slot_end)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (lot_id, buyer_user_id)
         DO UPDATE SET slot_start = EXCLUDED.slot_start, slot_end = EXCLUDED.slot_end
         WHERE pickup_assignments.pickup_schedule_id = $1`,
        [pickupScheduleId, lotId, buyerUserId, slotStart, slotEnd]
      );

      await client.query('COMMIT');
      return {
        pickup_schedule_id: pickupScheduleId,
        lot_id: lotId,
        slot_start: slotStart,
        slot_end: slotEnd
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async overridePickupSchedule(adminId, pickupScheduleId, newScheduleJson) {
    // Admin override: update schedule and mark as admin-overridden
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      await this._ensureAdminRole(client, adminId);

      const scheduleRes = await client.query(
        'SELECT id FROM pickup_schedules WHERE id = $1',
        [pickupScheduleId]
      );
      if (!scheduleRes.rows[0]) {
        throw new Error('Pickup schedule not found');
      }

      await client.query(
        `UPDATE pickup_schedules
         SET schedule = $1, admin_overridden = true, admin_override_by = $2, admin_override_at = now()
         WHERE id = $3`,
        [newScheduleJson, adminId, pickupScheduleId]
      );

      await client.query('COMMIT');
      return {
        pickup_schedule_id: pickupScheduleId,
        admin_overridden: true,
        admin_override_at: new Date()
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getPickupAssignment(lotId, buyerUserId) {
    // Buyer view: get pickup assignment for a lot (only if payment is paid)
    const assignment = await db.query(
      `SELECT pa.id, pa.slot_start, pa.slot_end, ps.auction_id
       FROM pickup_assignments pa
       JOIN pickup_schedules ps ON pa.pickup_schedule_id = ps.id
       WHERE pa.lot_id = $1 AND pa.buyer_user_id = $2`,
      [lotId, buyerUserId]
    );

    if (!assignment.rows[0]) {
      return null;
    }

    // Verify payment is paid before returning
    const payment = await db.query(
      'SELECT status FROM payments WHERE lot_id = $1 AND buyer_user_id = $2 AND status = \'paid\'',
      [lotId, buyerUserId]
    );

    if (!payment.rows[0]) {
      throw new Error('Pickup details available only for paid lots');
    }

    return {
      pickup_slot_id: assignment.rows[0].id,
      lot_id: lotId,
      slot_start: assignment.rows[0].slot_start,
      slot_end: assignment.rows[0].slot_end,
      auction_id: assignment.rows[0].auction_id
    };
  }

  // TODO: Implement pickup check-in logic with QR code verification
  // TODO: Implement pickup reminders/notifications before slot time
}

module.exports = new PickupScheduleService();
