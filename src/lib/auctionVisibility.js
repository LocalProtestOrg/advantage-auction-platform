'use strict';

/**
 * auctionVisibility — who may read an auction (and its lots) through the PUBLIC read endpoints.
 *
 * Owner rule (2026-09-28): an auction that is not yet public (draft / submitted / under_review) must not be retrievable
 * merely because someone has its id. Published, active and closed auctions stay public exactly as before. A not-yet-public
 * auction is readable only by its own seller, an admin, or active staff (moderation preview). Everyone else gets the
 * same 404 as a missing auction, so ids cannot be probed. Callers run optionalAuth first (Bearer or session cookie).
 */

const PUBLIC_AUCTION_STATES = ['published', 'active', 'closed'];

async function canViewAuction(req, { state, ownerUserId }) {
  if (PUBLIC_AUCTION_STATES.includes(state)) return true;
  const u = req && req.user;
  if (!u || !u.id) return false;
  if (u.role === 'admin') return true;
  if (ownerUserId && String(ownerUserId) === String(u.id)) return true;
  try {
    const ctx = await require('../middleware/requirePermission').loadStaffContext(req);
    if (ctx && ctx.staff_active && ctx.staff_role) return true;
  } catch (_e) { /* no staff context → not staff */ }
  return false;
}

module.exports = { PUBLIC_AUCTION_STATES, canViewAuction };
