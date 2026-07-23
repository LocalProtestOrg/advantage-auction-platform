'use strict';

/**
 * bridgeIdentityService — identity-only account linking for the BD bridge.
 *
 * A verified BD member proves ONLY their identity. This service:
 *  - links to an existing Advantage.Bid user IF that BD subject is already in external_identities;
 *  - otherwise creates a MINIMAL buyer account (never seller/org-owner/admin);
 *  - NEVER merges accounts on email; NEVER infers organization ownership (orgs stay unclaimed).
 */

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const db = require('../db');
const { withTransaction } = require('../utils/withTransaction');

const PROVIDER = 'brilliant_directories';

/**
 * Pure decision (unit-testable). Existing link → reuse that user (and its existing role). No link →
 * create a buyer. Never returns seller/org-owner/admin for the create path.
 */
function decideProvisioning({ existingLink }) {
  if (existingLink) return { action: 'link', userId: existingLink.userId, role: existingLink.role };
  return { action: 'create', role: 'buyer' };
}

async function findLink(bdUserId, runner) {
  const { rows } = await (runner || db).query(
    `SELECT u.id AS user_id, u.role
       FROM external_identities ei JOIN users u ON u.id = ei.user_id
      WHERE ei.provider = $1 AND ei.provider_subject = $2 LIMIT 1`,
    [PROVIDER, String(bdUserId)]);
  return rows[0] ? { userId: rows[0].user_id, role: rows[0].role } : null;
}

/** Returns { userId, role, created }. Identity only — no privilege elevation, no email merge. */
async function linkOrCreate(bdUserId, opts) {
  const id = String(bdUserId);
  const existingLink = await findLink(id);
  const plan = decideProvisioning({ existingLink });
  if (plan.action === 'link') return { userId: plan.userId, role: plan.role, created: false };

  return withTransaction(async (client) => {
    const again = await findLink(id, client); // re-check inside the txn (race-safe)
    if (again) return { userId: again.userId, role: again.role, created: false };
    // NON-PRODUCTION placeholder email: guarantees a NEW account and never links to an existing one
    // by email. The production bridge uses the verified BD email + an email-verification confirmation.
    const email = (opts && opts.email) || ('bd-' + id + '@bridge.invalid');
    // Bridge accounts never authenticate by password. Satisfy the required password_hash column with a
    // valid bcrypt hash of random bytes — a password nobody holds — so bcrypt.compare can never match.
    const unusablePassword = crypto.randomBytes(32).toString('base64');
    const passwordHash = await bcrypt.hash(unusablePassword, 10);
    const ins = await client.query(
      `INSERT INTO users (email, password_hash, role, auth_source)
       VALUES ($1, $2, 'buyer', 'bd_bridge')
       RETURNING id, role`,
      [email, passwordHash]);
    const user = ins.rows[0];
    await client.query(
      `INSERT INTO external_identities (user_id, provider, provider_subject, linked_at, last_verified_at)
       VALUES ($1, $2, $3, now(), now())`,
      [user.id, PROVIDER, id]);
    return { userId: user.id, role: user.role, created: true };
  });
}

module.exports = { PROVIDER, decideProvisioning, findLink, linkOrCreate };
