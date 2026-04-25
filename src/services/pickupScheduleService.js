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

  _ensureNonOverlapping(windows) {
    // Validate that time windows do not overlap
    // windows: array of { category, start, end }
    for (let i = 0; i < windows.length - 1; i++) {
      const current = windows[i];
      const next = windows[i + 1];
      
      // Current window's end must not exceed next window's start
      if (new Date(current.end) > new Date(next.start)) {
        throw new Error(
          `Category windows overlap: ${current.category} ends at ${current.end}, ` +
          `but ${next.category} starts at ${next.start}`
        );
      }
    }
  }

  _validateWindowOrdering(schedule) {
    // Ensure categories appear in strict order: A → B → C (no gaps or out-of-order)
    const categories = ['A', 'B', 'C'];
    const presentCategories = [];
    
    for (const cat of categories) {
      if (schedule[cat]) {
        presentCategories.push(cat);
      }
    }

    // Verify order matches A, B, C (no skipping or reordering)
    let catIndex = 0;
    for (const presentCat of presentCategories) {
      const expectedIndex = categories.indexOf(presentCat);
      if (expectedIndex < catIndex) {
        throw new Error(`Category order violation: ${presentCat} appears after already-used categories`);
      }
      catIndex = expectedIndex + 1;
    }
  }

  _validateTimeSpacing(schedule) {
    // Strict validation: A window < B window < C window, no overlaps, in order
    // Accounts for grace periods between slots
    const windows = [];
    for (const cat of ['A', 'B', 'C']) {
      if (schedule[cat]) {
        // Category window end: last slot end (no grace after last slot in category)
        const slots = schedule[cat].slots || [];
        const catEnd = slots.length > 0 ? slots[slots.length - 1].slot_end : schedule[cat].window_end;
        
        windows.push({
          category: cat,
          start: new Date(schedule[cat].window_start),
          end: new Date(catEnd)
        });
      }
    }

    // Check non-overlapping (allowing for natural end-to-start transitions)
    for (let i = 0; i < windows.length - 1; i++) {
      const current = windows[i];
      const next = windows[i + 1];
      
      // Current category end must not exceed next category start
      if (current.end > next.start) {
        throw new Error(
          `Category windows overlap: ${current.category} ends at ${current.end.toISOString()}, ` +
          `but ${next.category} starts at ${next.start.toISOString()}`
        );
      }
    }

    // Check proper ordering
    for (let i = 0; i < windows.length - 1; i++) {
      if (windows[i].category > windows[i + 1].category) {
        throw new Error(`Categories must be in order A → B → C, got ${windows[i].category} before ${windows[i + 1].category}`);
      }
    }
  }

  generateSubSlots(windowStart, windowEnd, lotCount, capacityPerSlot = 10, gracePeriodMs = 300000) {
    // Divide category window into sub-slots based on lot count
    // Each sub-slot has a capacity (default 10 items)
    // Grace period (5 min = 300000ms by default) buffer between consecutive slots
    // Returns array of sub-slots with individual time boundaries
    const numSlots = Math.ceil(lotCount / capacityPerSlot);
    const start = new Date(windowStart);
    const end = new Date(windowEnd);
    const totalMs = end - start;
    
    // Subtract grace period time (no gap after last slot)
    const totalGraceMs = (numSlots - 1) * gracePeriodMs;
    const availableMs = totalMs - totalGraceMs;
    
    if (availableMs <= 0) {
      throw new Error(
        `Insufficient time for ${numSlots} slots with ${gracePeriodMs / 60000} min grace periods. ` +
        `Window: ${totalMs / 60000} min, Required: ${totalMs / 60000 + totalGraceMs / 60000} min`
      );
    }

    const slotDurationMs = availableMs / numSlots;

    const subSlots = [];
    for (let i = 0; i < numSlots; i++) {
      const slotStart = new Date(start.getTime() + i * (slotDurationMs + gracePeriodMs));
      const slotEnd = new Date(slotStart.getTime() + slotDurationMs);
      subSlots.push({
        slot_number: i + 1,
        slot_start: slotStart,
        slot_end: slotEnd,
        grace_period_ms: i < numSlots - 1 ? gracePeriodMs : 0
      });
    }
    return subSlots;
  }


  async generateSchedule(adminId, auctionId) {
    // After auction closes, generate pickup windows for all paid lots
    // Groups by pickup_category (A, B, C) and assigns sequential time slots
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
        `SELECT id, pickup_category, winning_buyer_user_id
         FROM lots
         WHERE auction_id = $1 AND state = 'closed' AND winning_buyer_user_id IS NOT NULL
         ORDER BY pickup_category, id`,
        [auctionId]
      );
      const lots = lotsRes.rows;

      if (lots.length === 0) {
        throw new Error('No sold lots to generate pickup schedule');
      }

      // Group lots by pickup_category
      const byCat = { A: [], B: [], C: [] };
      for (const lot of lots) {
        if (lot.pickup_category && byCat[lot.pickup_category]) {
          byCat[lot.pickup_category].push(lot);
        }
      }

      // Generate sub-slots for each category (order: A, B, C)
      const categories = ['A', 'B', 'C'];
      const usedCategories = categories.filter(cat => byCat[cat].length > 0);
      
      // Grace period between slots and categories (5 minutes = 300000ms)
      const GRACE_PERIOD_MS = 300000; // 5 minutes
      
      // Calculate category window sizes accounting for grace periods
      const start = new Date(auction.pickup_window_start);
      const end = new Date(auction.pickup_window_end);
      const totalMs = end - start;
      
      // Reserve grace period buffer between categories (one less than number of categories)
      const interCategoryGraceMs = (usedCategories.length - 1) * GRACE_PERIOD_MS;
      const availableMs = totalMs - interCategoryGraceMs;
      const categoryDurationMs = availableMs / usedCategories.length;

      // Build schedule JSON with multiple sub-slots per category
      const schedule = {};
      const slotCapacityRecords = [];
      
      usedCategories.forEach((cat, idx) => {
        const catStart = new Date(
          start.getTime() + idx * (categoryDurationMs + GRACE_PERIOD_MS)
        );
        const catEnd = new Date(catStart.getTime() + categoryDurationMs);
        
        const subSlots = this.generateSubSlots(catStart, catEnd, byCat[cat].length, 10, GRACE_PERIOD_MS);
        
        schedule[cat] = {
          window_start: catStart,
          window_end: catEnd,
          lot_count: byCat[cat].length,
          capacity_per_slot: 10,
          grace_period_ms: GRACE_PERIOD_MS,
          slots: subSlots
        };

        // Queue slot capacity records for insertion
        subSlots.forEach(slot => {
          slotCapacityRecords.push({
            category: cat,
            slot_number: slot.slot_number,
            slot_start: slot.slot_start,
            slot_end: slot.slot_end,
            capacity: 10
          });
        });
      });

      // Validate time spacing: A < B < C, no overlaps, strict ordering
      this._validateTimeSpacing(schedule);

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

      // Create slots_capacity records
      for (const slot of slotCapacityRecords) {
        await client.query(
          `INSERT INTO slots_capacity (pickup_schedule_id, category, slot_number, slot_start, slot_end, capacity)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT DO NOTHING`,
          [scheduleId, slot.category, slot.slot_number, slot.slot_start, slot.slot_end, slot.capacity]
        );
      }

      await client.query('COMMIT');
      return {
        pickup_schedule_id: scheduleId,
        auction_id: auctionId,
        schedule,
        slot_capacity_count: slotCapacityRecords.length,
        generated_at: new Date()
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async assignPickupOnPayment(client, lotId, buyerUserId) {
    // Called by PaymentService when payment succeeds
    // Dynamically assign buyer to next available slot for their category
    // Prevents empty slot waste, enables real-time payment flow
    // Enforces: 1 assignment per lot (replaces existing if reassigning)
    const lotRes = await client.query(
      `SELECT pickup_category, auction_id FROM lots WHERE id = $1`,
      [lotId]
    );
    if (!lotRes.rows[0]) {
      throw new Error('Lot not found');
    }
    const lot = lotRes.rows[0];

    const scheduleRes = await client.query(
      'SELECT id FROM pickup_schedules WHERE auction_id = $1',
      [lot.auction_id]
    );
    if (!scheduleRes.rows[0]) {
      return null;
    }
    const scheduleId = scheduleRes.rows[0].id;

    const cat = lot.pickup_category;

    // Check if lot already has an assignment (handle reassignment)
    const existingRes = await client.query(
      `SELECT id, slot_start, slot_end FROM pickup_assignments WHERE lot_id = $1 FOR UPDATE`,
      [lotId]
    );
    
    if (existingRes.rows[0]) {
      // Lot already assigned - decrement old slot, reassign to new slot
      const oldAssignment = existingRes.rows[0];
      
      // Decrement old slot's assigned count
      await client.query(
        `UPDATE slots_capacity
         SET assigned = GREATEST(assigned - 1, 0), updated_at = now()
         WHERE pickup_schedule_id = $1 AND slot_start = $2 AND slot_end = $3`,
        [scheduleId, oldAssignment.slot_start, oldAssignment.slot_end]
      );
    }

    // Find first available slot with capacity (assigned < capacity)
    // Order by slot_number to fill sequentially
    const availableSlotRes = await client.query(
      `SELECT id, slot_start, slot_end, capacity, assigned
       FROM slots_capacity
       WHERE pickup_schedule_id = $1 AND category = $2 AND assigned < capacity
       ORDER BY slot_number ASC
       LIMIT 1
       FOR UPDATE`,
      [scheduleId, cat]
    );

    let targetSlot;
    if (availableSlotRes.rows[0]) {
      // Found available slot with capacity
      targetSlot = availableSlotRes.rows[0];
    } else {
      // All slots full - assign to last slot (overflow)
      const lastSlotRes = await client.query(
        `SELECT id, slot_start, slot_end, capacity, assigned
         FROM slots_capacity
         WHERE pickup_schedule_id = $1 AND category = $2
         ORDER BY slot_number DESC
         LIMIT 1
         FOR UPDATE`,
        [scheduleId, cat]
      );
      if (!lastSlotRes.rows[0]) {
        throw new Error(`No slots configured for category ${cat}`);
      }
      targetSlot = lastSlotRes.rows[0];
    }

    // Replace assignment (UPSERT via lot_id unique constraint)
    const assignmentRes = await client.query(
      `INSERT INTO pickup_assignments (pickup_schedule_id, lot_id, buyer_user_id, slot_start, slot_end)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (lot_id) DO UPDATE SET
         slot_start = EXCLUDED.slot_start,
         slot_end = EXCLUDED.slot_end,
         buyer_user_id = EXCLUDED.buyer_user_id
       WHERE pickup_assignments.lot_id = $2
       RETURNING id`,
      [scheduleId, lotId, buyerUserId, targetSlot.slot_start, targetSlot.slot_end]
    );

    // Increment assigned count for new slot (atomic update)
    await client.query(
      `UPDATE slots_capacity
       SET assigned = assigned + 1, updated_at = now()
       WHERE id = $1`,
      [targetSlot.id]
    );

    // Return pickup assignment info for notification trigger
    return {
      pickupAssignmentId: assignmentRes.rows[0]?.id,
      lot_id: lotId,
      buyer_user_id: buyerUserId,
      slot_start: targetSlot.slot_start,
      slot_end: targetSlot.slot_end,
      pickup_schedule_id: scheduleId,
      auction_id: lot.auction_id
    };
  }

  async getSlotStatus(pickupScheduleId, category) {
    // Get all slots for a category with capacity and assigned counts
    // Used for display and availability checks
    const slotsRes = await db.query(
      `SELECT id, slot_number, slot_start, slot_end, capacity, assigned
       FROM slots_capacity
       WHERE pickup_schedule_id = $1 AND category = $2
       ORDER BY slot_number ASC`,
      [pickupScheduleId, category]
    );

    return slotsRes.rows.map(slot => ({
      slot_id: slot.id,
      slot_number: slot.slot_number,
      slot_start: slot.slot_start,
      slot_end: slot.slot_end,
      capacity: slot.capacity,
      assigned: slot.assigned,
      available: slot.capacity - slot.assigned
    }));
  }

  async assignPickupSlot(adminId, pickupScheduleId, lotId, buyerUserId, slotStart, slotEnd) {
    // Admin tool to manually assign or override pickup slot
    // Enforces: 1 assignment per lot (replaces existing on reassignment)
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

      // Check if lot already has an assignment (handle reassignment)
      const existingRes = await client.query(
        `SELECT id, slot_start, slot_end FROM pickup_assignments WHERE lot_id = $1 FOR UPDATE`,
        [lotId]
      );

      if (existingRes.rows[0]) {
        // Lot already assigned - decrement old slot
        const oldAssignment = existingRes.rows[0];
        
        // Decrement old slot's assigned count
        await client.query(
          `UPDATE slots_capacity
           SET assigned = GREATEST(assigned - 1, 0), updated_at = now()
           WHERE pickup_schedule_id = $1 AND slot_start = $2 AND slot_end = $3`,
          [pickupScheduleId, oldAssignment.slot_start, oldAssignment.slot_end]
        );
      }

      // Replace assignment (UPSERT via lot_id unique constraint)
      await client.query(
        `INSERT INTO pickup_assignments (pickup_schedule_id, lot_id, buyer_user_id, slot_start, slot_end)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (lot_id) DO UPDATE SET
           slot_start = EXCLUDED.slot_start,
           slot_end = EXCLUDED.slot_end,
           buyer_user_id = EXCLUDED.buyer_user_id
         WHERE pickup_assignments.lot_id = $2`,
        [pickupScheduleId, lotId, buyerUserId, slotStart, slotEnd]
      );

      // Increment new slot's assigned count
      await client.query(
        `UPDATE slots_capacity
         SET assigned = assigned + 1, updated_at = now()
         WHERE pickup_schedule_id = $1 AND slot_start = $2 AND slot_end = $3`,
        [pickupScheduleId, slotStart, slotEnd]
      );

      await client.query('COMMIT');
      return {
        pickup_schedule_id: pickupScheduleId,
        lot_id: lotId,
        slot_start: slotStart,
        slot_end: slotEnd,
        reassigned: !!existingRes.rows[0]
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
    // Enforces: time spacing validation (A < B < C, no overlaps)
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

      // Parse and validate new schedule structure
      let newSchedule;
      try {
        newSchedule = typeof newScheduleJson === 'string' ? JSON.parse(newScheduleJson) : newScheduleJson;
      } catch (e) {
        throw new Error('Invalid schedule JSON');
      }

      // Validate time spacing before persisting
      this._validateTimeSpacing(newSchedule);

      await client.query(
        `UPDATE pickup_schedules
         SET schedule = $1, admin_overridden = true, admin_override_by = $2, admin_override_at = now()
         WHERE id = $3`,
        [JSON.stringify(newSchedule), adminId, pickupScheduleId]
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

  async markPickupMissed(lotId, buyerUserId) {
    // Mark a pickup slot as missed (called after slot end time passes)
    // Records scheduled slot info for potential rescheduling
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // Get the scheduled pickup assignment
      const assignmentRes = await client.query(
        `SELECT slot_start, slot_end FROM pickup_assignments
         WHERE lot_id = $1 AND buyer_user_id = $2
         LIMIT 1`,
        [lotId, buyerUserId]
      );
      if (!assignmentRes.rows[0]) {
        throw new Error('No pickup assignment found for this lot');
      }
      const assignment = assignmentRes.rows[0];

      // Create missed pickup record
      const missedRes = await client.query(
        `INSERT INTO missed_pickups (lot_id, buyer_user_id, scheduled_slot_start, scheduled_slot_end, status)
         VALUES ($1, $2, $3, $4, 'missed')
         ON CONFLICT (lot_id) DO UPDATE SET
           status = 'missed', missed_at = now()
         WHERE missed_pickups.status IN ('pickup_completed', 'penalty_waived')
         RETURNING id, missed_at`,
        [lotId, buyerUserId, assignment.slot_start, assignment.slot_end]
      );

      await client.query('COMMIT');
      return {
        missed_pickup_id: missedRes.rows[0].id,
        lot_id: lotId,
        missed_at: missedRes.rows[0].missed_at
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async reschedulePickup(adminId, missedPickupId, newSlotStart, newSlotEnd) {
    // Admin tool: reschedule a missed pickup to a new slot
    // Updates missed_pickup status and creates new pickup_assignment
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      await this._ensureAdminRole(client, adminId);

      const missedRes = await client.query(
        `SELECT lot_id, buyer_user_id, status FROM missed_pickups WHERE id = $1 FOR UPDATE`,
        [missedPickupId]
      );
      if (!missedRes.rows[0]) {
        throw new Error('Missed pickup record not found');
      }
      const missed = missedRes.rows[0];

      if (missed.status === 'pickup_completed' || missed.status === 'penalty_waived') {
        throw new Error(`Cannot reschedule: pickup status is ${missed.status}`);
      }

      // Update missed_pickup record
      await client.query(
        `UPDATE missed_pickups
         SET status = 'rescheduled', rescheduled_to_slot_start = $1, rescheduled_to_slot_end = $2, rescheduled_at = now()
         WHERE id = $3`,
        [newSlotStart, newSlotEnd, missedPickupId]
      );

      // Update pickup_assignments with new slot
      await client.query(
        `UPDATE pickup_assignments
         SET slot_start = $1, slot_end = $2
         WHERE lot_id = $3 AND buyer_user_id = $4`,
        [newSlotStart, newSlotEnd, missed.lot_id, missed.buyer_user_id]
      );

      await client.query('COMMIT');
      return {
        missed_pickup_id: missedPickupId,
        lot_id: missed.lot_id,
        rescheduled_to_start: newSlotStart,
        rescheduled_to_end: newSlotEnd,
        status: 'rescheduled'
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getPenaltyAmount(missedPickupId, storageFeeDailyUSD = 50) {
    // Calculate penalty amount based on storage duration
    // Default: $50/day storage fee (configurable by admin)
    const missedRes = await db.query(
      `SELECT missed_at, rescheduled_at, penalty_amount_cents FROM missed_pickups WHERE id = $1`,
      [missedPickupId]
    );
    if (!missedRes.rows[0]) {
      throw new Error('Missed pickup not found');
    }
    const missed = missedRes.rows[0];

    // If already penalized, return existing amount
    if (missed.penalty_amount_cents) {
      return missed.penalty_amount_cents;
    }

    // Calculate days in storage (missed to now, or rescheduled time)
    const endTime = missed.rescheduled_at ? new Date(missed.rescheduled_at) : new Date();
    const startTime = new Date(missed.missed_at);
    const daysInStorage = Math.ceil((endTime - startTime) / (1000 * 60 * 60 * 24));
    const penaltyAmountCents = daysInStorage * storageFeeDailyUSD * 100;

    return penaltyAmountCents;
  }

  async applyPenalty(adminId, missedPickupId, penaltyAmountCents) {
    // Admin action: apply penalty to missed pickup
    // TODO: Integrate with PaymentService for actual charge/invoice
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      await this._ensureAdminRole(client, adminId);

      const missedRes = await client.query(
        `SELECT lot_id, status FROM missed_pickups WHERE id = $1 FOR UPDATE`,
        [missedPickupId]
      );
      if (!missedRes.rows[0]) {
        throw new Error('Missed pickup not found');
      }

      if (missedRes.rows[0].status === 'penalty_waived') {
        throw new Error('Cannot apply penalty: already waived');
      }

      await client.query(
        `UPDATE missed_pickups
         SET penalty_amount_cents = $1, penalty_applied_at = now()
         WHERE id = $2`,
        [penaltyAmountCents, missedPickupId]
      );

      await client.query('COMMIT');
      return {
        missed_pickup_id: missedPickupId,
        penalty_amount_cents: penaltyAmountCents,
        penalty_applied_at: new Date()
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async waivePenalty(adminId, missedPickupId, reason) {
    // Admin action: waive penalty for missed pickup (compassion, system error, etc.)
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      await this._ensureAdminRole(client, adminId);

      const missedRes = await client.query(
        `SELECT id FROM missed_pickups WHERE id = $1 FOR UPDATE`,
        [missedPickupId]
      );
      if (!missedRes.rows[0]) {
        throw new Error('Missed pickup not found');
      }

      await client.query(
        `UPDATE missed_pickups
         SET status = 'penalty_waived', notes = $1, updated_at = now()
         WHERE id = $2`,
        [reason || 'Waived by admin', missedPickupId]
      );

      await client.query('COMMIT');
      return {
        missed_pickup_id: missedPickupId,
        status: 'penalty_waived',
        reason: reason || 'Waived by admin'
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getMissedPickupHistory(buyerUserId) {
    // Buyer view: get history of missed pickups
    const missedRes = await db.query(
      `SELECT id, lot_id, missed_at, status, penalty_amount_cents, rescheduled_at
       FROM missed_pickups
       WHERE buyer_user_id = $1
       ORDER BY missed_at DESC`,
      [buyerUserId]
    );

    return missedRes.rows.map(row => ({
      missed_pickup_id: row.id,
      lot_id: row.lot_id,
      missed_at: row.missed_at,
      status: row.status,
      penalty_amount_cents: row.penalty_amount_cents,
      rescheduled_at: row.rescheduled_at
    }));
  }

  // TODO: Implement pickup check-in logic with QR code verification
  // TODO: Implement pickup reminders/notifications before slot time
  // TODO: Integrate penalty application with PaymentService for charges/invoices
  // TODO: Implement automatic missed pickup detection (scheduled job after slot end)

}

module.exports = new PickupScheduleService();
