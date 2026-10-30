'use strict';

/**
 * registry — every watchdog check, its risk tier and its schedule.
 *
 * Tiers and schedules (by risk and cost):
 *   critical  every 15 minutes (server checks); browser checks hourly from the scheduled job
 *   high      every hour
 *   normal    every 6 hours
 *
 * Severity of a finding = the check's tier when the problem is critical, else 'warning'. Only 'critical' and 'high'
 * findings send an alert (once, when new or re-opened). 'normal' and 'warning' findings appear on the dashboard only.
 *
 * Server checks (src/services/watchdog/httpChecks.js) run inside the platform. Browser checks run in a real browser in
 * the scheduled job (scripts/watchdog-browser.js) and post their results to POST /api/watchdog/ingest; they are listed
 * here so the ingest accepts only known checks and the dashboard knows their feature and tier.
 */

const { CHECKS: SERVER_CHECKS } = require('./httpChecks');

const TIER_INTERVAL_MIN = Object.freeze({ critical: 15, high: 60, normal: 360 });
const TIERS = Object.keys(TIER_INTERVAL_MIN);

// Browser checks (non-destructive, production). id → feature / tier. Desktop and mobile results share the check id;
// the viewport is part of each finding's dedupe key.
const BROWSER_CHECKS = Object.freeze([
  { id: 'browser-home', feature: 'Homepage and navigation (browser)', tier: 'critical' },
  { id: 'browser-login', feature: 'Sign in and registration (browser, not submitted)', tier: 'critical' },
  { id: 'browser-forgot-password', feature: 'Password reset request page (browser, not submitted)', tier: 'high' },
  { id: 'browser-search', feature: 'Search and filtering (browser)', tier: 'high' },
  { id: 'browser-marketplace', feature: 'Marketplace items (browser)', tier: 'high' },
  { id: 'browser-auction', feature: 'Auction page (browser)', tier: 'high' },
  { id: 'browser-lot', feature: 'Lot page (browser)', tier: 'high' },
  { id: 'browser-event', feature: 'Event page and structured data (browser)', tier: 'high' },
  { id: 'browser-product', feature: 'Marketplace product page (browser)', tier: 'high' },
  { id: 'browser-storefront', feature: 'Professional Seller storefront (browser)', tier: 'high' },
  { id: 'browser-widget', feature: 'Embedded storefront widget (browser)', tier: 'high' },
  { id: 'browser-journeys', feature: 'Isolated user journeys (test environment)', tier: 'critical' },
]);

const ALL = () => [
  ...SERVER_CHECKS.map((c) => ({ id: c.id, feature: c.feature, tier: c.tier, kind: c.kind })),
  ...BROWSER_CHECKS.map((c) => ({ ...c, kind: 'browser' })),
];
const byId = (id) => ALL().find((c) => c.id === id) || null;

/** A finding's severity from the check's tier and the problem's own severity. */
function severityFor(tier, issueSeverity) {
  if (issueSeverity !== 'critical') return 'warning';
  return TIERS.includes(tier) ? tier : 'normal';
}
const ALERTING = new Set(['critical', 'high']);
const alertable = (severity) => ALERTING.has(severity);

/** Whether a server check is due, given its tier and the last time it ran. */
function isDue(tier, lastRunAt, now = new Date()) {
  if (!lastRunAt) return true;
  const mins = TIER_INTERVAL_MIN[tier] || TIER_INTERVAL_MIN.normal;
  return now.getTime() - new Date(lastRunAt).getTime() >= mins * 60 * 1000 - 30 * 1000;   // 30 s of slack for tick jitter
}

module.exports = { SERVER_CHECKS, BROWSER_CHECKS, TIER_INTERVAL_MIN, TIERS, ALL, byId, severityFor, alertable, isDue };
