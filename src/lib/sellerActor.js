'use strict';

/**
 * sellerActor.js — who is acting for a seller company, for the storefront services.
 *
 * An "actor" is either:
 *   • the seller context resolved by requireSellerPermission (req.sellerCtx = { sellerId, role, userId, staff }); the
 *     company always comes from the session, never from a URL, body, header or widget parameter; or
 *   • for older callers, the company OWNER's user id (a string), resolved through seller_profiles.user_id.
 * Services use these helpers so a staff member acts for their own company only, and every record names the real person.
 */
const db = require('../db');
const { hasSellerPermission } = require('./sellerRbac');

const isCtx = (a) => !!a && typeof a === 'object';

async function sellerRow(actor, runner = db, columns = 'id, seller_type') {
  if (isCtx(actor)) {
    if (!actor.sellerId) return null;
    return (await runner.query(`SELECT ${columns} FROM seller_profiles WHERE id = $1`, [actor.sellerId])).rows[0] || null;
  }
  if (!actor) return null;
  return (await runner.query(`SELECT ${columns} FROM seller_profiles WHERE user_id = $1`, [actor])).rows[0] || null;
}

// The person acting (owner or staff) — what audit records and history name.
function actorUserId(actor) { return isCtx(actor) ? actor.userId : actor; }

// A bare user id is the owner path (resolved by seller_profiles.user_id), which holds every company permission.
function can(actor, permission) { return isCtx(actor) ? hasSellerPermission(actor, permission) : !!actor; }

module.exports = { sellerRow, actorUserId, can, isCtx };
