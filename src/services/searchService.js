'use strict';
// Buyer discovery search — pure query-clause builders (no DB), unit-testable.
// Produces parameterized WHERE clauses + an ORDER BY for the public lot/auction
// search endpoints. All user text is bound as parameters (never interpolated);
// only fixed column/keyword SQL is concatenated.

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, min), max);
}

// Build lot-search clauses. `q` is the request query object. Returns
// { where: string[], params: any[], orderBy: string }. Params are 1-indexed in
// the order pushed; the caller appends LIMIT/OFFSET params afterward.
function buildLotSearch(q) {
  q = q || {};
  const params = [];
  const where = [];
  where.push("l.state != 'withdrawn'");
  where.push('a.is_archived IS NOT TRUE');

  // Status filter (buyer-facing lifecycle).
  const status = String(q.status || '').toLowerCase();
  if (status === 'active')        where.push("a.state = 'active' AND l.state = 'open'");
  else if (status === 'upcoming') where.push("a.state = 'published'");
  else if (status === 'closed')   where.push("(a.state = 'closed' OR l.state = 'closed')");
  else                             where.push("a.state IN ('published','active')"); // default: live

  // Free-text search (trigram-indexed substring match across the lot's text).
  if (q.q && typeof q.q === 'string' && q.q.trim()) {
    params.push('%' + q.q.trim().slice(0, 100) + '%');
    const i = params.length;
    where.push(`(l.title ILIKE $${i} OR l.description ILIKE $${i} OR l.category ILIKE $${i} OR l.maker_artist ILIKE $${i})`);
  }
  // Exact category filter (real category browse).
  if (q.category && typeof q.category === 'string' && q.category.trim()) {
    params.push(q.category.trim());
    where.push(`l.category = $${params.length}`);
  }
  // Location filters (via the auction).
  if (q.address_state && String(q.address_state).trim()) {
    params.push(String(q.address_state).trim().toUpperCase());
    where.push(`a.address_state = $${params.length}`);
  }
  if (q.city && String(q.city).trim()) {
    params.push('%' + String(q.city).trim() + '%');
    where.push(`a.city ILIKE $${params.length}`);
  }
  if (q.shippable === 'true') where.push('l.shippable = true');
  if (q.ending_soon === 'true') {
    where.push("l.state = 'open'");
    where.push('l.closes_at > NOW()');
    where.push("l.closes_at <= NOW() + INTERVAL '48 hours'");
  }

  const orderBy =
      q.sort === 'ending_soon' ? 'l.closes_at ASC NULLS LAST'
    : q.sort === 'newest'      ? 'l.created_at DESC'
    : q.sort === 'most_bids'   ? 'l.bid_count DESC, l.closes_at ASC NULLS LAST'
    : 'l.closes_at ASC NULLS LAST'; // default: soonest-closing first

  return { where, params, orderBy };
}

// Admin buyer search (Phase 3). Returns { where, params } over `users u`
// (role='buyer'); `q` matches email (substring). `active` filters is_active.
function buildBuyerSearch(q) {
  q = q || {};
  const params = [];
  const where = ["u.role = 'buyer'"];
  if (q.q && typeof q.q === 'string' && q.q.trim()) {
    params.push('%' + q.q.trim().slice(0, 100) + '%');
    where.push(`u.email ILIKE $${params.length}`);
  }
  if (q.active === 'true')  where.push('u.is_active IS NOT FALSE');
  if (q.active === 'false') where.push('u.is_active = false');
  return { where, params };
}

module.exports = { buildLotSearch, buildBuyerSearch, clampInt };
