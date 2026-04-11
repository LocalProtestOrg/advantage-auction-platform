// EventEmitter - Lightweight event system for decoupling services
// Allows core logic to emit events without knowing about handlers
// Enables queuing, retries, batching, and multi-channel fanout

class EventEmitter {
  constructor() {
    this.handlers = new Map();
  }

  // Register event handler
  on(eventType, handler) {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, []);
    }
    this.handlers.get(eventType).push(handler);
  }

  // Remove event handler
  off(eventType, handler) {
    const handlers = this.handlers.get(eventType);
    if (handlers) {
      const index = handlers.indexOf(handler);
      if (index > -1) {
        handlers.splice(index, 1);
      }
    }
  }

  // Emit event (fire-and-forget, non-blocking)
  emit(eventType, payload) {
    const handlers = this.handlers.get(eventType);
    if (handlers) {
      // Process handlers asynchronously to avoid blocking core logic
      setImmediate(() => {
        handlers.forEach(handler => {
          try {
            handler(payload);
          } catch (error) {
            console.error(`Error in event handler for ${eventType}:`, error.message);
          }
        });
      });
    }
  }

  // Emit event with promise (for testing/debugging)
  emitAsync(eventType, payload) {
    return new Promise((resolve) => {
      const handlers = this.handlers.get(eventType);
      if (!handlers || handlers.length === 0) {
        resolve([]);
        return;
      }

      const results = [];
      let completed = 0;

      const checkComplete = () => {
        completed++;
        if (completed === handlers.length) {
          resolve(results);
        }
      };

      handlers.forEach((handler, index) => {
        try {
          const result = handler(payload);
          if (result && typeof result.then === 'function') {
            // Handler returned a promise
            result.then(
              (success) => {
                results[index] = { success: true, result: success };
                checkComplete();
              },
              (error) => {
                results[index] = { success: false, error: error.message };
                checkComplete();
              }
            );
          } else {
            // Handler was synchronous
            results[index] = { success: true, result };
            checkComplete();
          }
        } catch (error) {
          results[index] = { success: false, error: error.message };
          checkComplete();
        }
      });
    });
  }
}

// Global event emitter instance
const eventEmitter = new EventEmitter();

// Event types (constants for consistency)
const EVENTS = {
  BID_OUTBID: 'BID_OUTBID',
  AUCTION_WON: 'AUCTION_WON',
  PAYMENT_CONFIRMED: 'PAYMENT_CONFIRMED',
  PICKUP_SCHEDULED: 'PICKUP_SCHEDULED',
  USER_REGISTERED: 'USER_REGISTERED'
};

// Convenience function for emitting events
function emitEvent(eventType, payload) {
  eventEmitter.emit(eventType, payload);
}

// Convenience function for emitting events with promise (for testing)
function emitEventAsync(eventType, payload) {
  return eventEmitter.emitAsync(eventType, payload);
}

module.exports = {
  EventEmitter,
  eventEmitter,
  EVENTS,
  emitEvent,
  emitEventAsync
};
