// Event-Driven Notification Pattern Example
// This demonstrates the new decoupled notification architecture

const { emitEvent, EVENTS } = require('./eventEmitter');
const { NOTIFICATION_TYPES } = require('./notificationService');

// Example: Core business logic emits events instead of calling services directly
async function exampleBidPlacement() {
  // ... core bidding logic ...

  // Instead of: notificationService.sendOutbidAlert(...)
  // Now emit event (fire-and-forget, non-blocking)
  emitEvent(EVENTS.BID_OUTBID, {
    buyerUserId: 'user-123',
    lotId: 'lot-456',
    auctionId: 'auction-789',
    newBidAmount: 50000 // $500.00
  });

  // ... continue with core logic ...
}

// Example: Payment processing emits multiple events
async function examplePaymentSuccess() {
  // ... core payment logic ...

  // Emit payment confirmation event
  emitEvent(EVENTS.PAYMENT_CONFIRMED, {
    buyerUserId: 'user-123',
    paymentId: 'payment-456',
    lotId: 'lot-789',
    auctionId: 'auction-101',
    amountCents: 52500 // $525.00 (including buyer premium)
  });

  // Emit pickup scheduled event
  emitEvent(EVENTS.PICKUP_SCHEDULED, {
    buyerUserId: 'user-123',
    pickupAssignmentId: 'pickup-456',
    lotId: 'lot-789',
    auctionId: 'auction-101',
    slotStart: '2024-01-15T14:00:00Z',
    slotEnd: '2024-01-15T14:30:00Z'
  });

  // ... continue with core logic ...
}

// Benefits of this pattern:
// ✅ Decoupled: Core services don't know about notification implementation
// ✅ Scalable: Easy to add queues (Redis, SQS), retries, batching
// ✅ Testable: Events can be mocked for unit tests
// ✅ Extensible: New notification types just need new event types
// ✅ White-label ready: Templates can be customized per deployment
// ✅ Future-proof: Easy to add Handlebars/EJS template engines
// ✅ Type-safe: NOTIFICATION_TYPES enum prevents typos and chaos
// ✅ Reliable: Event processing doesn't block core business logic

module.exports = {
  exampleBidPlacement,
  examplePaymentSuccess
};
