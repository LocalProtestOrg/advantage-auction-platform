// NotificationService implementation
// Handles all user notifications across channels (email, SMS, push)
// Event-driven design allows queuing, retries, batching, and multi-channel fanout

const { eventEmitter, EVENTS } = require('./eventEmitter');
const db = require('../db');

// Notification types enum (standardized constants)
const NOTIFICATION_TYPES = {
  OUTBID: 'outbid',
  AUCTION_WON: 'auction_won',
  PAYMENT_CONFIRMED: 'payment_confirmed',
  PICKUP_SCHEDULED: 'pickup_scheduled',
  REGISTRATION_CONFIRMATION: 'registration_confirmation'
};

class NotificationService {
  constructor() {
    this.init();
  }

  init() {
    // Register event handlers
    eventEmitter.on(EVENTS.BID_OUTBID, this._handleBidOutbid.bind(this));
    eventEmitter.on(EVENTS.AUCTION_WON, this._handleAuctionWon.bind(this));
    eventEmitter.on(EVENTS.PAYMENT_CONFIRMED, this._handlePaymentConfirmed.bind(this));
    eventEmitter.on(EVENTS.PICKUP_SCHEDULED, this._handlePickupScheduled.bind(this));
    eventEmitter.on(EVENTS.USER_REGISTERED, this._handleUserRegistered.bind(this));
  }

  // Event handler methods (called by eventEmitter)
  async _handleBidOutbid(payload) {
    await this._sendOutbidAlert(payload.buyerUserId, payload.lotId, payload.auctionId, payload.newBidAmount);
  }

  async _handleAuctionWon(payload) {
    await this._sendAuctionWonNotification(payload.buyerUserId, payload.auctionId, payload.lotId, payload.winningAmount);
  }

  async _handlePaymentConfirmed(payload) {
    await this._sendPaymentConfirmation(payload.buyerUserId, payload.paymentId, payload.lotId, payload.auctionId, payload.amountCents);
  }

  async _handlePickupScheduled(payload) {
    await this._sendPickupScheduledNotification(payload.buyerUserId, payload.pickupAssignmentId, payload.lotId, payload.auctionId, payload.slotStart, payload.slotEnd);
  }

  async _handleUserRegistered(payload) {
    await this._sendRegistrationConfirmation(payload.userId, payload.email);
  }
  async _ensureNotificationPreferences(client, userId) {
    // Ensure user has notification preferences (create defaults if missing)
    const prefRes = await client.query(
      'SELECT id FROM notification_preferences WHERE user_id = $1',
      [userId]
    );
    
    if (!prefRes.rows[0]) {
      await client.query(
        `INSERT INTO notification_preferences (user_id)
         VALUES ($1)
         ON CONFLICT DO NOTHING`,
        [userId]
      );
    }
  }

  async _checkPreference(client, userId, notificationType, channel = 'email') {
    // Check if user has opted in for this notification type + channel
    const columnName = `${channel}_${notificationType}`;
    
    const prefRes = await client.query(
      `SELECT ${columnName} FROM notification_preferences WHERE user_id = $1`,
      [userId]
    );

    if (!prefRes.rows[0]) {
      return false;
    }

    return prefRes.rows[0][columnName] !== false;
  }

  async _logNotification(client, userId, notificationType, channel, subject, body, relatedData = {}) {
    // Store notification in database for audit trail and retry logic
    const notificationRes = await client.query(
      `INSERT INTO notifications 
       (user_id, notification_type, channel, subject, body, related_auction_id, related_lot_id, related_payment_id, related_pickup_id, recipient_email, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        userId,
        notificationType,
        channel,
        subject,
        body,
        relatedData.auctionId || null,
        relatedData.lotId || null,
        relatedData.paymentId || null,
        relatedData.pickupId || null,
        relatedData.email || null,
        JSON.stringify(relatedData.metadata || {})
      ]
    );

    return notificationRes.rows[0].id;
  }

  async _sendEmail(recipientEmail, templateConfig) {
    // Template-based email sending for white-label support
    // templateConfig: { template: 'auction_won', data: { ... } }
    
    const { template, data, _preRendered } = templateConfig;
    
    let subject, body;
    if (_preRendered) {
      // For retries, use pre-rendered content
      subject = _preRendered.subject;
      body = _preRendered.body;
    } else {
      // Render from template
      const rendered = this._renderEmailTemplate(template, data);
      subject = rendered.subject;
      body = rendered.body;
    }
    
    // Mock email send (console log for now)
    // TODO: Integrate with email provider (SendGrid, Mailgun, etc.)
    console.log('📧 EMAIL NOTIFICATION');
    console.log(`   To: ${recipientEmail}`);
    console.log(`   Template: ${template}`);
    console.log(`   Subject: ${subject}`);
    console.log(`   Body: ${body}`);
    console.log('---');
    
    return {
      sent: true,
      provider: 'mock',
      timestamp: new Date(),
      template,
      recipientEmail
    };
  }

  _renderEmailTemplate(template, data) {
    // Template rendering engine for email content
    // TODO: Replace with proper template engine (Handlebars, EJS, etc.)
    
    const templates = {
      [NOTIFICATION_TYPES.OUTBID]: {
        subject: '😢 You\'ve been outbid - Advantage Auctions',
        body: `
You have been outbid on: ${data.lotTitle}

New bid: $${(data.newBidAmount / 100).toFixed(2)}

Place a new bid to stay in the competition!

${new Date().toISOString()}
        `.trim()
      },
      
      [NOTIFICATION_TYPES.AUCTION_WON]: {
        subject: '🎉 Congratulations! You Won - Advantage Auctions',
        body: `
Congratulations! You won: ${data.lotTitle}

From auction: ${data.auctionTitle}
Your winning bid: $${(data.winningAmount / 100).toFixed(2)}

Proceed to payment to secure your item.

${new Date().toISOString()}
        `.trim()
      },
      
      [NOTIFICATION_TYPES.PAYMENT_CONFIRMED]: {
        subject: '✅ Payment Confirmed - Advantage Auctions',
        body: `
Payment confirmed for: ${data.lotTitle}

Amount: $${(data.amountCents / 100).toFixed(2)}
Payment ID: ${data.paymentId}

Your pickup slot will be assigned shortly.

${new Date().toISOString()}
        `.trim()
      },
      
      [NOTIFICATION_TYPES.PICKUP_SCHEDULED]: {
        subject: '📦 Your Pickup Slot Assigned - Advantage Auctions',
        body: `
Pickup slot scheduled for: ${data.lotTitle}

Pickup window:
Start: ${data.slotStartFormatted}
End: ${data.slotEndFormatted}

Please pick up your item during this window.

${new Date().toISOString()}
        `.trim()
      },
      
      [NOTIFICATION_TYPES.REGISTRATION_CONFIRMATION]: {
        subject: '👋 Welcome to Advantage Auctions',
        body: `
Welcome! Your account has been created.

Email: ${data.email}

Start bidding, selling, or managing auctions today!

${new Date().toISOString()}
        `.trim()
      }
    };
    
    const templateData = templates[template];
    if (!templateData) {
      throw new Error(`Unknown email template: ${template}`);
    }
    
    return templateData;
  }

  async _sendSMS(recipientPhone, body) {
    // Mock SMS send (console log for now)
    // TODO: Integrate with SMS provider (Twilio, AWS SNS, etc.)
    console.log('📱 SMS NOTIFICATION');
    console.log(`   To: ${recipientPhone}`);
    console.log(`   Body: ${body}`);
    console.log('---');

    return {
      sent: true,
      provider: 'mock',
      timestamp: new Date()
    };
  }

  async _deliverNotification(notificationId, channel, recipientEmail, recipientPhone, templateConfig) {
    // Deliver notification via specified channel
    // Updates notification status based on delivery result
    try {
      let result;
      
      if (channel === 'email') {
        // Check if this is a retry with pre-rendered content
        if (templateConfig.data.subject && templateConfig.data.body) {
          // For retries, use the stored subject/body directly
          result = await this._sendEmail(recipientEmail, {
            template: templateConfig.template,
            data: templateConfig.data,
            _preRendered: { subject: templateConfig.data.subject, body: templateConfig.data.body }
          });
        } else {
          result = await this._sendEmail(recipientEmail, templateConfig);
        }
      } else if (channel === 'sms') {
        // For SMS, we still need to construct the body from template
        let body;
        if (templateConfig.data.body) {
          // For retries, use stored body
          body = templateConfig.data.body;
        } else {
          const rendered = this._renderEmailTemplate(templateConfig.template, templateConfig.data);
          body = rendered.body;
        }
        result = await this._sendSMS(recipientPhone, body);
      } else if (channel === 'push') {
        // TODO: Implement push notification
        let body;
        if (templateConfig.data.body) {
          // For retries, use stored body
          body = templateConfig.data.body;
        } else {
          const rendered = this._renderEmailTemplate(templateConfig.template, templateConfig.data);
          body = rendered.body;
        }
        console.log('📲 PUSH NOTIFICATION');
        console.log(`   Body: ${body}`);
        console.log('---');
        result = { sent: true, provider: 'mock', timestamp: new Date() };
      }

      if (result.sent) {
        // Mark as sent
        await db.query(
          `UPDATE notifications SET status = 'sent', sent_at = now() WHERE id = $1`,
          [notificationId]
        );
        return { success: true, notificationId };
      } else {
        throw new Error('Delivery failed');
      }
    } catch (error) {
      // Mark as failed and increment retry count
      await db.query(
        `UPDATE notifications 
         SET status = 'failed', failed_reason = $1, retry_count = retry_count + 1
         WHERE id = $2`,
        [error.message, notificationId]
      );
      throw error;
    }
  }

  async _sendOutbidAlert(buyerUserId, lotId, auctionId, newBidAmount) {
    // Notify buyer that they've been outbid
    // Called from BidService.placeBid() when outbidding a previous bidder
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      await this._ensureNotificationPreferences(client, buyerUserId);

      const userRes = await client.query(
        'SELECT email FROM users WHERE id = $1',
        [buyerUserId]
      );
      if (!userRes.rows[0]) {
        throw new Error('User not found');
      }
      const userEmail = userRes.rows[0].email;

      const lotRes = await client.query(
        'SELECT title FROM lots WHERE id = $1',
        [lotId]
      );
      const lotTitle = lotRes.rows[0]?.title || 'Lot';

      // Check email preference
      const emailEnabled = await this._checkPreference(client, buyerUserId, NOTIFICATION_TYPES.OUTBID, 'email');
      
      if (emailEnabled) {
        // Get rendered content for logging
        const templateData = { lotTitle, newBidAmount };
        const { subject, body } = this._renderEmailTemplate(NOTIFICATION_TYPES.OUTBID, templateData);

        const notificationId = await this._logNotification(
          client,
          buyerUserId,
          NOTIFICATION_TYPES.OUTBID,
          'email',
          subject,
          body,
          { auctionId, lotId, email: userEmail, metadata: { newBidAmount } }
        );

        await client.query('COMMIT');
        await this._deliverNotification(notificationId, 'email', userEmail, null, { template: NOTIFICATION_TYPES.OUTBID, data: templateData });
      } else {
        await client.query('COMMIT');
      }

      return {
        success: true,
        userId: buyerUserId,
        notificationType: NOTIFICATION_TYPES.OUTBID,
        sent: emailEnabled
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async _sendAuctionWonNotification(buyerUserId, auctionId, lotId, winningAmount) {
    // Notify winner that they won an auction
    // Called from AuctionService.closeAuction() for each winning bidder
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      await this._ensureNotificationPreferences(client, buyerUserId);

      const userRes = await client.query(
        'SELECT email FROM users WHERE id = $1',
        [buyerUserId]
      );
      if (!userRes.rows[0]) {
        throw new Error('User not found');
      }
      const userEmail = userRes.rows[0].email;

      const lotRes = await client.query(
        'SELECT title FROM lots WHERE id = $1',
        [lotId]
      );
      const lotTitle = lotRes.rows[0]?.title || 'Lot';

      const auctionRes = await client.query(
        'SELECT title FROM auctions WHERE id = $1',
        [auctionId]
      );
      const auctionTitle = auctionRes.rows[0]?.title || 'Auction';

      const emailEnabled = await this._checkPreference(client, buyerUserId, NOTIFICATION_TYPES.AUCTION_WON, 'email');

      if (emailEnabled) {
        // Get rendered content for logging
        const templateData = { lotTitle, auctionTitle, winningAmount };
        const { subject, body } = this._renderEmailTemplate(NOTIFICATION_TYPES.AUCTION_WON, templateData);

        const notificationId = await this._logNotification(
          client,
          buyerUserId,
          NOTIFICATION_TYPES.AUCTION_WON,
          'email',
          subject,
          body,
          { auctionId, lotId, email: userEmail, metadata: { winningAmount } }
        );

        await client.query('COMMIT');
        await this._deliverNotification(notificationId, 'email', userEmail, null, { template: NOTIFICATION_TYPES.AUCTION_WON, data: templateData });
      } else {
        await client.query('COMMIT');
      }

      return {
        success: true,
        userId: buyerUserId,
        notificationType: NOTIFICATION_TYPES.AUCTION_WON,
        sent: emailEnabled
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async _sendPaymentConfirmation(buyerUserId, paymentId, lotId, auctionId, amountCents) {
    // Notify buyer that payment was received
    // Called from PaymentService.recordPaymentSuccess()
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      await this._ensureNotificationPreferences(client, buyerUserId);

      const userRes = await client.query(
        'SELECT email FROM users WHERE id = $1',
        [buyerUserId]
      );
      if (!userRes.rows[0]) {
        throw new Error('User not found');
      }
      const userEmail = userRes.rows[0].email;

      const lotRes = await client.query(
        'SELECT title FROM lots WHERE id = $1',
        [lotId]
      );
      const lotTitle = lotRes.rows[0]?.title || 'Lot';

      const emailEnabled = await this._checkPreference(client, buyerUserId, 'payment_confirmed', 'email');

      if (emailEnabled) {
        // Get rendered content for logging
        const templateData = { lotTitle, amountCents, paymentId };
        const { subject, body } = this._renderEmailTemplate(NOTIFICATION_TYPES.PAYMENT_CONFIRMED, templateData);

        const notificationId = await this._logNotification(
          client,
          buyerUserId,
          NOTIFICATION_TYPES.PAYMENT_CONFIRMED,
          'email',
          subject,
          body,
          { auctionId, lotId, paymentId, email: userEmail, metadata: { amountCents } }
        );

        await client.query('COMMIT');
        await this._deliverNotification(notificationId, 'email', userEmail, null, { template: NOTIFICATION_TYPES.PAYMENT_CONFIRMED, data: templateData });
      } else {
        await client.query('COMMIT');
      }

      return {
        success: true,
        userId: buyerUserId,
        notificationType: NOTIFICATION_TYPES.PAYMENT_CONFIRMED,
        sent: emailEnabled
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async _sendPickupScheduledNotification(buyerUserId, pickupAssignmentId, lotId, auctionId, slotStart, slotEnd) {
    // Notify buyer that pickup slot was assigned
    // Called from PickupScheduleService.assignPickupOnPayment()
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      await this._ensureNotificationPreferences(client, buyerUserId);

      const userRes = await client.query(
        'SELECT email FROM users WHERE id = $1',
        [buyerUserId]
      );
      if (!userRes.rows[0]) {
        throw new Error('User not found');
      }
      const userEmail = userRes.rows[0].email;

      const lotRes = await client.query(
        'SELECT title FROM lots WHERE id = $1',
        [lotId]
      );
      const lotTitle = lotRes.rows[0]?.title || 'Lot';

      const emailEnabled = await this._checkPreference(client, buyerUserId, 'pickup_scheduled', 'email');

      if (emailEnabled) {
        // Get rendered content for logging
        const slotStartDate = new Date(slotStart);
        const slotEndDate = new Date(slotEnd);
        const templateData = { 
          lotTitle, 
          slotStartFormatted: slotStartDate.toLocaleString(),
          slotEndFormatted: slotEndDate.toLocaleString()
        };
        const { subject, body } = this._renderEmailTemplate(NOTIFICATION_TYPES.PICKUP_SCHEDULED, templateData);

        const notificationId = await this._logNotification(
          client,
          buyerUserId,
          NOTIFICATION_TYPES.PICKUP_SCHEDULED,
          'email',
          subject,
          body,
          { auctionId, lotId, pickupId: pickupAssignmentId, email: userEmail, metadata: { slotStart, slotEnd } }
        );

        await client.query('COMMIT');
        await this._deliverNotification(notificationId, 'email', userEmail, null, { template: NOTIFICATION_TYPES.PICKUP_SCHEDULED, data: templateData });
      } else {
        await client.query('COMMIT');
      }

      return {
        success: true,
        userId: buyerUserId,
        notificationType: NOTIFICATION_TYPES.PICKUP_SCHEDULED,
        sent: emailEnabled
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async _sendRegistrationConfirmation(userId, email) {
    // Send welcome/registration confirmation email
    // Called from AuthService on signup
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      await this._ensureNotificationPreferences(client, userId);

      // Get rendered content for logging
      const templateData = { email };
      const { subject, body } = this._renderEmailTemplate(NOTIFICATION_TYPES.REGISTRATION_CONFIRMATION, templateData);

      const notificationId = await this._logNotification(
        client,
        userId,
        NOTIFICATION_TYPES.REGISTRATION_CONFIRMATION,
        'email',
        subject,
        body,
        { email, metadata: {} }
      );

      await client.query('COMMIT');
      await this._deliverNotification(notificationId, 'email', email, null, { template: NOTIFICATION_TYPES.REGISTRATION_CONFIRMATION, data: templateData });

      return {
        success: true,
        userId,
        notificationType: NOTIFICATION_TYPES.REGISTRATION_CONFIRMATION,
        sent: true
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async retryFailedNotifications(maxRetries = 3) {
    // Retry failed notifications (for scheduled job)
    // TODO: Call this from a scheduled job (cron) outside of request/response cycle
    const failedRes = await db.query(
      `SELECT id, user_id, notification_type, channel, subject, body, recipient_email, recipient_phone, retry_count, max_retries
       FROM notifications
       WHERE status = 'failed' AND retry_count < max_retries
       ORDER BY created_at ASC
       LIMIT 100`
    );

    const results = [];
    for (const notification of failedRes.rows) {
      try {
        // For retries, reconstruct template config from stored data
        const templateConfig = {
          template: notification.notification_type,
          data: { subject: notification.subject, body: notification.body }
        };
        
        await this._deliverNotification(
          notification.id,
          notification.channel,
          notification.recipient_email,
          notification.recipient_phone,
          templateConfig
        );
        results.push({ id: notification.id, success: true });
      } catch (error) {
        results.push({ id: notification.id, success: false, error: error.message });
      }
    }

    return {
      retried: failedRes.rows.length,
      results
    };
  }

  async updateNotificationPreference(userId, channel, notificationType, enabled) {
    // Allow users to update their notification preferences
    const columnName = `${channel}_${notificationType}`;
    
    await db.query(
      `UPDATE notification_preferences SET ${columnName} = $1, updated_at = now() WHERE user_id = $2`,
      [enabled, userId]
    );

    return {
      userId,
      channel,
      notificationType,
      enabled
    };
  }

  // TODO: Integrate with SendGrid, Mailgun, or similar for production emails
  // TODO: Integrate with Twilio or AWS SNS for SMS
  // TODO: Implement push notifications (Firebase, OneSignal, etc.)
  // TODO: Schedule retry job for failed notifications
  // TODO: Add notification templates for better email formatting
  // TODO: Implement user notification dashboard/history view
}

module.exports = {
  NotificationService: new NotificationService(),
  NOTIFICATION_TYPES
};

// ── queueNotification ─────────────────────────────────────────────────────────
// Standalone helper — inserts one row into notifications_queue using the shared
// connection pool (NOT a transaction client). Use this from routes or services
// that are operating outside an open transaction.
//
// For insertion inside a transaction (e.g. resolveProxyBid), use client.query
// directly so the queue entry commits atomically with the bid.
//
// @param {string} userId   - UUID of the recipient
// @param {string} type     - 'OUTBID' | 'LEADING' | 'WINNING' | 'ENDING_SOON'
// @param {object} payload  - context the delivery worker will use
async function queueNotification({ userId, type, payload = {} }) {
  await db.query(
    `INSERT INTO notifications_queue (user_id, type, payload)
     VALUES ($1, $2, $3)`,
    [userId, type, JSON.stringify(payload)]
  );
}

module.exports.queueNotification = queueNotification;
