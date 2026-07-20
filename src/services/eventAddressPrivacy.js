'use strict';

/**
 * Event address privacy — the "Hide Address Until" engine (reusable, pure logic, no I/O).
 *
 * Replicates the approved Marketplace behavior: an event's exact address is withheld from the
 * public until a reveal trigger fires (default: 24 hours before the sale start), then published.
 * This is SERVER-AUTHORITATIVE — the public serializer emits nothing precise before the reveal,
 * exactly like the auction address policy ("the API must return nothing before reveal"). It is
 * never a CSS/client trick.
 *
 * Modes (events.address_privacy_mode):
 *   exact        — public venue; the full address is always shown.
 *   hidden_until — address hidden until the trigger fires, then shown (the BD default).
 *   approximate  — the exact address is never published; only the general area (city/state/zip).
 *
 * Triggers (events.address_reveal_trigger, for hidden_until):
 *   hours_before_start — reveal N hours before start_at (default 24).
 *   on_date            — reveal at address_reveal_at.
 *   on_registration / on_approval — not time-based; stays hidden to the public for now (future).
 *
 * The public marker exposed post-reveal is still the ~0.10-mile OFFSET (events.lat/lng), never the
 * precise internal_lat/lng — those are never surfaced by any public serializer.
 */

const HIDDEN = 'hidden_until';
const EXACT = 'exact';
const APPROX = 'approximate';
const DEFAULT_HOURS = 24;

function toDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
function hoursBefore(event) {
  const h = Number(event && event.address_reveal_hours_before);
  return Number.isFinite(h) && h >= 0 ? h : DEFAULT_HOURS;
}

/** When (Date) the exact address becomes public, or null if it never auto-reveals. */
function revealAt(event) {
  const e = event || {};
  if (e.address_privacy_mode !== HIDDEN) return null; // exact = already public; approximate = never
  const trigger = e.address_reveal_trigger || 'hours_before_start';
  if (trigger === 'on_date') return toDate(e.address_reveal_at);
  if (trigger === 'hours_before_start') {
    const start = toDate(e.start_at);
    if (!start) return null;
    return new Date(start.getTime() - hoursBefore(e) * 3600 * 1000);
  }
  return null; // on_registration / on_approval — never auto-reveals to the anonymous public
}

/** Is the exact address currently public? */
function isRevealed(event, now) {
  const mode = (event && event.address_privacy_mode) || EXACT;
  if (mode === EXACT) return true;
  if (mode === APPROX) return false;
  const at = revealAt(event);
  if (!at) return false; // hidden with no computable reveal → stay hidden
  const t = toDate(now) || new Date();
  return t.getTime() >= at.getTime();
}

/** Human notice shown while the address is withheld (mirrors the approved BD copy). */
function revealNotice(event, at) {
  const e = event || {};
  if (e.address_privacy_mode === APPROX) return 'The exact address is not published for this listing.';
  const trigger = e.address_reveal_trigger || 'hours_before_start';
  if (trigger === 'hours_before_start') {
    const h = hoursBefore(e);
    return `The full address will be published ${h} hours prior to the sale start time.`;
  }
  return 'The full address will be published closer to the sale start time.';
}

/**
 * The public-safe location view for a serializer. NEVER returns internal_lat/lng. Emits the exact
 * address + public (offset) marker only when revealed; otherwise the general area + a reveal notice.
 * `now` is injectable for testing/caching.
 */
function publicLocationView(event, now) {
  const e = event || {};
  const revealed = isRevealed(e, now);
  const at = revealAt(e);
  const view = {
    venue_name: e.venue_name || null,
    city: e.city || null,
    state: e.state || null,
    zip: e.zip || null,
    address_hidden: !revealed,
    address_reveal_at: (!revealed && at) ? at.toISOString() : null,
  };
  if (revealed) {
    view.address = e.address || null;
    view.lat = e.lat != null ? Number(e.lat) : null; // public OFFSET marker, not the precise point
    view.lng = e.lng != null ? Number(e.lng) : null;
  } else {
    view.address = null; // withheld server-side
    view.lat = null;
    view.lng = null; // no precise map before reveal (BD parity)
    view.reveal_notice = revealNotice(e, at);
  }
  return view;
}

module.exports = {
  revealAt,
  isRevealed,
  revealNotice,
  publicLocationView,
  MODES: { HIDDEN, EXACT, APPROX },
  DEFAULT_HOURS,
};
