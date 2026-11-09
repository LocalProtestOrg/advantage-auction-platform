'use strict';

/**
 * Professional Storefront purchase policies (owner decisions 2026-11-09). One place for the rules the order, issue and payout
 * code share; the buyer-facing wording lives in the purchase terms (docs/legal/storefront-purchase-terms-addendum-draft.md).
 *
 *   1. Sales are final after payment: there is no buyer cancellation after a successful payment (no such route exists).
 *      Refunds remain available through Advantage.Bid (problem reports, administrator refunds) and card disputes.
 *   2. Uncollected purchases follow the seller's published Shipping & Pickup Policy. Advantage.Bid imposes no forfeiture
 *      deadline and nothing happens automatically when time passes: an order is payable to the seller only after the seller
 *      confirms pickup or delivery (and the reporting period below has passed).
 *   3. Ordinary returns follow the seller's published Store Terms; a report that an item is materially different from its
 *      listing can always be made and is reviewed by Advantage.Bid, whatever the seller's return policy says.
 *   4. Reporting expectations: 48 hours after pickup, 7 days after delivery, counted from the time the pickup or delivery
 *      was recorded (never the payment date). They are expectations, NEVER a reason the system refuses or closes a report:
 *      a later report is accepted and reviewed like any other (reportTiming() only informs the reviewer).
 *   5. No refund fee: a refund returns the full amount the buyer paid (marketplaceOrderService.refundOrder).
 *
 * Purchases need the seller's published Store Terms AND Shipping & Pickup Policy, shown to the buyer before payment; the
 * exact versions are recorded on the order (migration 203).
 */

const REPORT_WINDOW_HOURS = Object.freeze({ pickup: 48, shipping: 7 * 24 });
const WINDOW_BASIS = Object.freeze({ pickup: 'pickup', shipping: 'delivery' });

// The fulfillment step that starts the reporting period: pickup confirmed, or delivery confirmed (a shipped order's
// "delivered" step; its internal status value is 'completed').
const FULFILLED_TO = Object.freeze(['picked_up', 'completed']);

// SQL: the moment the order's pickup or delivery was recorded, from the order's permanent, append-only history (migration
// 197: one such step per order; the database refuses any change to history). `alias` is the marketplace_orders alias.
function fulfilledAtSql(alias = 'o') {
  return `(SELECT min(e.created_at) FROM marketplace_order_events e
            WHERE e.order_id = ${alias}.id AND e.event_type = 'fulfillment' AND e.data->>'to' IN ('picked_up', 'completed'))`;
}

// SQL: the order's reporting period ended at or before `cutoffParam` (a timestamptz expression). An order without a
// recorded pickup or delivery never passes (fails closed).
function reportingPeriodEndedSql(alias, cutoffParam) {
  return `EXISTS (SELECT 1 FROM marketplace_order_events e
                   WHERE e.order_id = ${alias}.id AND e.event_type = 'fulfillment' AND e.data->>'to' IN ('picked_up', 'completed')
                     AND e.created_at + (CASE WHEN ${alias}.fulfillment_method = 'shipping' THEN interval '${REPORT_WINDOW_HOURS.shipping} hours'
                                              ELSE interval '${REPORT_WINDOW_HOURS.pickup} hours' END) <= ${cutoffParam})`;
}

function toDate(v) { if (v == null || v === '') return null; const d = v instanceof Date ? v : new Date(v); return Number.isNaN(d.getTime()) ? null : d; }

// The order's reporting period: { basis: 'pickup'|'delivery', hours, starts_at, ends_at } (null dates while pickup or
// delivery has not been recorded).
function reportingWindow(fulfillmentMethod, fulfilledAt) {
  const method = fulfillmentMethod === 'shipping' ? 'shipping' : 'pickup';
  const start = toDate(fulfilledAt);
  const hours = REPORT_WINDOW_HOURS[method];
  return { basis: WINDOW_BASIS[method], hours, starts_at: start ? start.toISOString() : null,
    ends_at: start ? new Date(start.getTime() + hours * 3600 * 1000).toISOString() : null };
}

// For the reviewer ONLY (never used to refuse, close or decide a report): when the report was made relative to the period.
//   'before_fulfillment' — pickup/delivery not recorded yet (e.g. not received)    'within' — inside the period
//   'after'              — after the period; still reviewed on its merits          'unknown' — the times cannot be read
function reportTiming(window, reportedAt) {
  const at = toDate(reportedAt);
  if (!window || !at) return 'unknown';
  if (!window.starts_at) return 'before_fulfillment';
  return at.getTime() <= new Date(window.ends_at).getTime() ? 'within' : 'after';
}

module.exports = { REPORT_WINDOW_HOURS, FULFILLED_TO, fulfilledAtSql, reportingPeriodEndedSql, reportingWindow, reportTiming };
