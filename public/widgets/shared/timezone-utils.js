/* timezone-utils.js — convert a datetime-local value ("YYYY-MM-DDTHH:mm") to a UTC
 * ISO instant interpreting the wall-clock in a chosen IANA timezone (NOT the
 * browser's). DST-correct via native Intl (no dependency). Mirrors
 * src/lib/timezoneUtils.js. Exposes window.TimezoneUtils. Default America/New_York. */
(function () {
  var DEFAULT_TZ = 'America/New_York';
  function tzOffsetMs(utcDate, tz) {
    var dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    var p = dtf.formatToParts(utcDate).reduce(function (a, x) { a[x.type] = x.value; return a; }, {});
    var hour = p.hour === '24' ? 0 : Number(p.hour);
    var asUTC = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hour, Number(p.minute), Number(p.second));
    return asUTC - utcDate.getTime();
  }
  function localToUtcIso(localStr, tz) {
    tz = tz || DEFAULT_TZ;
    if (!localStr) return undefined;
    var parts = String(localStr).split('T');
    if (!parts[0]) return undefined;
    var d = parts[0].split('-').map(Number);
    var t = (parts[1] || '00:00').split(':').map(Number);
    var wallAsUTC = Date.UTC(d[0], (d[1] || 1) - 1, d[2] || 1, t[0] || 0, t[1] || 0, 0);
    var guess = wallAsUTC - tzOffsetMs(new Date(wallAsUTC), tz);
    guess = wallAsUTC - tzOffsetMs(new Date(guess), tz); // refine across DST boundary
    return new Date(guess).toISOString();
  }
  function utcIsoToLocalInput(iso, tz) {
    tz = tz || DEFAULT_TZ;
    if (!iso) return '';
    var dtf = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
    var p = dtf.formatToParts(new Date(iso)).reduce(function (a, x) { a[x.type] = x.value; return a; }, {});
    var hh = p.hour === '24' ? '00' : p.hour;
    return p.year + '-' + p.month + '-' + p.day + 'T' + hh + ':' + p.minute;
  }
  window.TimezoneUtils = { DEFAULT_TZ: DEFAULT_TZ, localToUtcIso: localToUtcIso, utcIsoToLocalInput: utcIsoToLocalInput };
})();
