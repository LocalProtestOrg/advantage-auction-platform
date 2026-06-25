'use strict';

/**
 * timezoneUtils — convert between a naive datetime-local string ("YYYY-MM-DDTHH:mm")
 * and a UTC instant, interpreting the wall-clock in a specific IANA timezone (not the
 * runtime/browser timezone). DST-correct via native Intl (no dependency).
 *
 * Mirrors public/widgets/shared/timezone-utils.js. Default tz America/New_York.
 */

const DEFAULT_TZ = 'America/New_York';

// Offset (ms) such that: localWallClock(utcDate, tz) === utcDate + offset.
// i.e., how far the tz's wall clock is ahead of UTC at that instant (negative west).
function tzOffsetMs(utcDate, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const p = dtf.formatToParts(utcDate).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  const hour = p.hour === '24' ? 0 : Number(p.hour);
  const asUTC = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hour, Number(p.minute), Number(p.second));
  return asUTC - utcDate.getTime();
}

// "YYYY-MM-DDTHH:mm" interpreted in `tz` → UTC ISO string. Double-pass for DST edges.
function localToUtcIso(localStr, tz) {
  tz = tz || DEFAULT_TZ;
  if (!localStr) return undefined;
  const [datePart, timePart] = String(localStr).split('T');
  if (!datePart) return undefined;
  const [y, mo, d] = datePart.split('-').map(Number);
  const [h, mi] = (timePart || '00:00').split(':').map(Number);
  const wallAsUTC = Date.UTC(y, (mo || 1) - 1, d || 1, h || 0, mi || 0, 0);
  let guess = wallAsUTC - tzOffsetMs(new Date(wallAsUTC), tz);
  guess = wallAsUTC - tzOffsetMs(new Date(guess), tz); // refine across DST boundary
  return new Date(guess).toISOString();
}

// UTC ISO → "YYYY-MM-DDTHH:mm" wall-clock in `tz` (for a datetime-local input value).
function utcIsoToLocalInput(iso, tz) {
  tz = tz || DEFAULT_TZ;
  if (!iso) return '';
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = dtf.formatToParts(new Date(iso)).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  const hh = p.hour === '24' ? '00' : p.hour;
  return `${p.year}-${p.month}-${p.day}T${hh}:${p.minute}`;
}

module.exports = { DEFAULT_TZ, tzOffsetMs, localToUtcIso, utcIsoToLocalInput };
