// PaymentService implementation
const db = require('../db');

class PaymentService {
  async _ensureAdminRole(client, adminId) {
    const user = await client.query('SELECT role FROM users WHERE id = $1', [adminId]);
    if (!user.rows[0] || user.rows[0].role !== 'admin') {
      throw new Error('Unauthorized: Admin only');
    }
  }

  async createPaymentIntent(userId, auctionId, lotId) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const lotRes = await client.query(
        'SELECT state, winning_buyer_user_id, winning_amount_cents FROM lots WHERE id = $1 AND auction_id = $2',
        [lotId, auctionId]
      );
      if (!lotRes.rows[0]) {
        throw new Error('Lot not found');
      }
      const lot = lotRes.rows[0];

      // Lot must be closed (winner locked at closeAuction time)
      if (lot.state !== 'closed') {
        throw new Error('Lot must be closed before payment');
      }

      // Winning bidder must be set (locked at close time)
      if (!lot.winning_buyer_user_id || lot.winning_amount_cents === null) {
        throw new Error('Lot has no assigned winner');
      }

      // Only winning bidder can create payment
      if (lot.winning_buyer_user_id !== userId) {
        throw new Error('Only winning bidder can create payment');
      }

      // Check if payment already exists (active, pending, or paid)
      // DB constraint prevents duplicates, but this provides clear error handling
      const existingPayment = await client.query(
        `SELECT id, status FROM payments
         WHERE lot_id = $1 AND buyer_user_id = $2 AND status IN ('pending', 'paid', 'refunded', 'partially_refunded')
         LIMIT 1`,
        [lotId, userId]
      );
      if (existingPayment.rows[0]) {
        throw new Error(`Payment already exists for this lot (status: ${existingPayment.rows[0].status}). Cannot create duplicate.`);
      }

      // Create pending payment with locked winning amount
      const payment = await client.query(
        `INSERT INTO payments (auction_id, lot_id, buyer_user_id, amount_cents, status)
         VALUES ($1, $2, $3, $4, 'pending')
         RETURNING id, amount_cents, status, created_at`,
        [auctionId, lotId, userId, lot.winning_amount_cents]
      );

      await client.query('COMMIT');
      return {
        id: payment.rows[0].id,
        lot_id: lotId,
        auction_id: auctionId,
        amount_cents: payment.rows[0].amount_cents,
        status: payment.rows[0].status,
        created_at: payment.rows[0].created_at
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async recordPaymentSuccess(paymentId, paymentProviderId) {
    // Record successful payment from provider
    // Winner and amount already locked at auction close
    // Valid transition: pending → paid (and ONLY from pending)
    // Trigger: Assign buyer to pickup slot based on lot's size_category
    // Trigger: Send payment confirmation notification
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const paymentRes = await client.query(
        'SELECT lot_id, buyer_user_id, amount_cents, status FROM payments WHERE id = $1 FOR UPDATE',
        [paymentId]
      );
      if (!paymentRes.rows[0]) {
        throw new Error('Payment not found');
      }
      const payment = paymentRes.rows[0];

      // Guard: ONLY pending → paid allowed
      if (payment.status !== 'pending') {
        throw new Error(`Cannot mark ${payment.status} payment as paid. Only pending payments can be charged.`);
      }

      // Get lot info for notifications
      const lotRes = await client.query(
        'SELECT auction_id FROM lots WHERE id = $1',
        [payment.lot_id]
      );
      const auctionId = lotRes.rows[0]?.auction_id;

      // Update payment status
      await client.query(
        `UPDATE payments
         SET status = 'paid', charged_at = now(), payment_provider_id = $1, last_attempted_at = now()
         WHERE id = $2`,
        [paymentProviderId, paymentId]
      );

      // Assign buyer to pickup slot
      const pickupScheduleService = require('./pickupScheduleService');
      const pickupAssignment = await pickupScheduleService.assignPickupOnPayment(client, payment.lot_id, payment.buyer_user_id);

      await client.query('COMMIT');
      client.release();

      // Emit notification events asynchronously (fire-and-forget, non-blocking)
      const { emitEvent, EVENTS } = require('./eventEmitter');

      // Payment confirmation event
      emitEvent(EVENTS.PAYMENT_CONFIRMED, {
        buyerUserId: payment.buyer_user_id,
        paymentId,
        lotId: payment.lot_id,
        auctionId,
        amountCents: payment.amount_cents
      });

      // Pickup scheduled event - only if assignment exists in database after commit
      if (pickupAssignment?.pickupAssignmentId) {
        // Verify assignment exists in database (prevent race condition)
        const verifyClient = await db.connect();
        try {
          const verifyRes = await verifyClient.query(
            `SELECT id, slot_start, slot_end FROM pickup_assignments
             WHERE id = $1 AND lot_id = $2 AND buyer_user_id = $3`,
            [pickupAssignment.pickupAssignmentId, payment.lot_id, payment.buyer_user_id]
          );

          if (verifyRes.rows[0]) {
            const verifiedAssignment = verifyRes.rows[0];
            emitEvent(EVENTS.PICKUP_SCHEDULED, {
              buyerUserId: payment.buyer_user_id,
              pickupAssignmentId: verifiedAssignment.id,
              lotId: payment.lot_id,
              auctionId,
              slotStart: verifiedAssignment.slot_start,
              slotEnd: verifiedAssignment.slot_end
            });
          } else {
            console.warn(`Pickup assignment ${pickupAssignment.pickupAssignmentId} not found after commit - notification skipped`);
          }
        } catch (verifyError) {
          console.error('Failed to verify pickup assignment:', verifyError.message);
        } finally {
          verifyClient.release();
        }
      }

      return {
        payment_id: paymentId,
        status: 'paid',
        charged_at: new Date()
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async recordPaymentFailure(paymentId) {
    // Record failed payment attempt and increment retry count
    // Valid transition: pending → pending (retry) OR pending → failed (after 3 retries)
    // Tracks last_attempted_at for optional cooldown/retry scheduling logic
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const paymentRes = await client.query(
        'SELECT status, retry_count FROM payments WHERE id = $1 FOR UPDATE',
        [paymentId]
      );
      if (!paymentRes.rows[0]) {
        throw new Error('Payment not found');
      }

      // Guard: ONLY pending can fail/retry
      if (paymentRes.rows[0].status !== 'pending') {
        throw new Error(`Cannot retry ${paymentRes.rows[0].status} payment. Only pending payments can be retried.`);
      }

      const newRetryCount = (paymentRes.rows[0].retry_count || 0) + 1;

      // Update to failed status after 3 retries, otherwise stay pending
      const newStatus = newRetryCount >= 3 ? 'failed' : 'pending';

      // Record attempt timestamp for cooldown/scheduling logic
      await client.query(
        `UPDATE payments
         SET status = $1, retry_count = $2, last_attempted_at = now()
         WHERE id = $3`,
        [newStatus, newRetryCount, paymentId]
      );

      await client.query('COMMIT');
      return {
        payment_id: paymentId,
        status: newStatus,
        retry_count: newRetryCount,
        last_attempted_at: new Date()
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // TODO: Implement optional cooldown/backoff logic (e.g., exponential backoff between retries)
  // TODO: Add query to find payments eligible for retry based on last_attempted_at + cooldown window

  async processRefund(adminId, paymentId, refundAmountCents) {
    // Admin-only refund logic
    // Valid transition: paid → refunded OR paid → partially_refunded (and ONLY from paid)
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      await this._ensureAdminRole(client, adminId);

      const paymentRes = await client.query(
        'SELECT status, amount_cents FROM payments WHERE id = $1 FOR UPDATE',
        [paymentId]
      );
      if (!paymentRes.rows[0]) {
        throw new Error('Payment not found');
      }
      const payment = paymentRes.rows[0];

      // Guard: ONLY paid → refunded/partially_refunded allowed
      if (payment.status !== 'paid') {
        throw new Error(`Cannot refund ${payment.status} payment. Only paid payments can be refunded.`);
      }

      if (refundAmountCents <= 0 || refundAmountCents > payment.amount_cents) {
        throw new Error('Refund amount must be between 0 and the payment amount');
      }

      const isFullRefund = refundAmountCents === payment.amount_cents;
      const newStatus = isFullRefund ? 'refunded' : 'partially_refunded';

      await client.query(
        `UPDATE payments
         SET status = $1, refunded_at = now()
         WHERE id = $2`,
        [newStatus, paymentId]
      );

      await client.query('COMMIT');
      return {
        payment_id: paymentId,
        status: newStatus,
        refund_amount_cents: refundAmountCents,
        refunded_at: new Date()
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getPaymentStatus(paymentId) {
    const payment = await db.query(
      'SELECT id, lot_id, buyer_user_id, amount_cents, status, charged_at, created_at FROM payments WHERE id = $1',
      [paymentId]
    );
    if (!payment.rows[0]) {
      throw new Error('Payment not found');
    }
    return payment.rows[0];
  }

  async _ensurePaymentVerified(client, lotId, buyerUserId) {
    // Guard for address visibility: payment must be 'paid' to reveal full address
    // Used to prevent premature address disclosure before payment confirmed
    const payment = await client.query(
      'SELECT status FROM payments WHERE lot_id = $1 AND buyer_user_id = $2 ORDER BY created_at DESC LIMIT 1',
      [lotId, buyerUserId]
    );
    if (!payment.rows[0]) {
      throw new Error('No payment record found');
    }
    if (payment.rows[0].status !== 'paid') {
      throw new Error('Full address available only after payment is confirmed');
    }
  }

  // TODO: In route/seller view layer: IF payment.status !== 'paid' THEN hide auction.address_encrypted
  // TODO: Decrypt and return full address ONLY after _ensurePaymentVerified() passes
  // TODO: Add buyer invoice generation that includes address (only for paid payments)
}

module.exports = new PaymentService();
