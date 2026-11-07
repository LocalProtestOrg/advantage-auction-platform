'use strict';

/**
 * platformOwner — is this account the platform owner (users.is_platform_owner, migration 222)?
 *
 * Read from the database on every check (never from the session token), and FAIL CLOSED: an unknown account, an
 * inactive account, a non-admin account, a missing column (migration not applied) or a database error all mean
 * "not the owner". The owner is designated only by scripts/prod-set-platform-owner.js.
 */

const db = require('../db');

const OWNER_REQUIRED_MESSAGE = 'Only the platform owner can make this change.';

async function isPlatformOwner(user, runner = db) {
  const id = user && (user.id || user.userId || user.user_id);
  if (!id) return false;
  try {
    const u = (await runner.query('SELECT role, is_active, is_platform_owner FROM users WHERE id = $1', [id])).rows[0];
    return !!(u && u.role === 'admin' && u.is_active !== false && u.is_platform_owner === true);
  } catch (e) {
    console.error('[platform-owner] check failed (treated as not the owner):', e.message);
    return false;
  }
}

/** Express middleware: 403 unless the signed-in account is the platform owner. */
function requirePlatformOwner(req, res, next) {
  isPlatformOwner(req.user).then((ok) => {
    if (ok) return next();
    return res.status(403).json({ success: false, code: 'PLATFORM_OWNER_REQUIRED', message: OWNER_REQUIRED_MESSAGE });
  }, () => res.status(403).json({ success: false, code: 'PLATFORM_OWNER_REQUIRED', message: OWNER_REQUIRED_MESSAGE }));
}

function ownerRequiredError(detail) {
  const e = new Error(OWNER_REQUIRED_MESSAGE + (detail ? ' (' + detail + ')' : ''));
  e.status = 403; e.code = 'PLATFORM_OWNER_REQUIRED'; e.expose = true;
  return e;
}

module.exports = { isPlatformOwner, requirePlatformOwner, ownerRequiredError, OWNER_REQUIRED_MESSAGE };
