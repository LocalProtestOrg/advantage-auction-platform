'use strict';

/**
 * bridgeIdentityService — identity-only account provisioning for the BD bridge.
 *
 * A verified BD member proves ONLY their identity (their stable BD member ID = provider_subject).
 * redeemAndProvision claims the one-time code and provisions the identity in a SINGLE transaction:
 *  - if that BD subject is already linked, reuse its user (refreshing contact info only), else
 *  - create a MINIMAL buyer (never seller/org-owner/admin).
 * It NEVER merges/associates/authenticates an existing account by email; NEVER infers organization
 * ownership. users.email is a namespaced, undeliverable internal login identifier; the member's real
 * inbox is stored in users.contact_email (resolved by recipientService for all outbound mail).
 * Because the code claim and provisioning share one transaction, a provisioning failure rolls the
 * whole thing back and the code is NOT consumed (safe retry).
 */

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const db = require('../db');
const { withTransaction } = require('../utils/withTransaction');
const { sha256 } = require('./bridgeCodeService');

const PROVIDER = 'brilliant_directories';

// Pure decision (unit-testable). Existing link → reuse that user (and its existing role). No link →
// create a buyer. Never returns seller/org-owner/admin for the create path; never keys on email.
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

// Namespaced, undeliverable internal login identifier. Never emailed. Unique per BD subject, so it
// can never collide with, or be merged into, a real account's email.
function internalEmail(bdUserId) { return 'bd-' + String(bdUserId) + '@bridge.invalid'; }

// Provision within an existing transaction `client`. claims = { email, firstName, lastName }.
async function provisionWithinTxn(client, bdUserId, claims) {
  const id = String(bdUserId);
  const c = claims || {};
  const existing = await findLink(id, client);

  if (existing) {
    // Repeat visit: refresh contact info to the latest verified BD values. NEVER changes the identity
    // key (provider_subject) and NEVER changes the user's role/privileges. Scoped to bridge accounts.
    await client.query(
      `UPDATE users SET contact_email = COALESCE($2, contact_email)
        WHERE id = $1 AND auth_source = 'bd_bridge'`,
      [existing.userId, c.email || null]);
    await client.query(
      `UPDATE external_identities
          SET provider_email      = COALESCE($3, provider_email),
              provider_first_name = COALESCE($4, provider_first_name),
              provider_last_name  = COALESCE($5, provider_last_name),
              last_verified_at    = now()
        WHERE provider = $1 AND provider_subject = $2`,
      [PROVIDER, id, c.email || null, c.firstName || null, c.lastName || null]);
    return { userId: existing.userId, role: existing.role, created: false };
  }

  // Create a minimal buyer. Bridge accounts never authenticate by password: store a valid bcrypt hash
  // of random bytes (a password nobody holds). users.email is the namespaced internal id; the real
  // inbox goes to contact_email; names are stored for reference.
  const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('base64'), 10);
  const fullName = [c.firstName, c.lastName].map((s) => (s ? String(s).trim() : '')).filter(Boolean).join(' ') || null;
  const ins = await client.query(
    `INSERT INTO users (email, contact_email, password_hash, role, auth_source, full_name)
     VALUES ($1, $2, $3, 'buyer', 'bd_bridge', $4)
     RETURNING id, role`,
    [internalEmail(id), c.email || null, passwordHash, fullName]);
  const user = ins.rows[0];
  await client.query(
    `INSERT INTO external_identities
       (user_id, provider, provider_subject, provider_email, provider_first_name, provider_last_name, linked_at, last_verified_at)
     VALUES ($1, $2, $3, $4, $5, $6, now(), now())`,
    [user.id, PROVIDER, id, c.email || null, c.firstName || null, c.lastName || null]);
  return { userId: user.id, role: user.role, created: true };
}

// Atomic redeem + provision. Claims an unused, unexpired code AND provisions identity in ONE
// transaction. Returns { dest, userId, role, created } or null (unknown/expired/replayed). A failure
// anywhere rolls back the claim, so the code survives for a legitimate retry.
async function redeemAndProvision(rawCode) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE bd_login_codes SET used_at = now()
        WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()
        RETURNING bd_user_id, dest, provider_email, provider_first_name, provider_last_name`,
      [sha256(String(rawCode == null ? '' : rawCode))]);
    const row = rows[0];
    if (!row) return null;
    const identity = await provisionWithinTxn(client, row.bd_user_id, {
      email: row.provider_email, firstName: row.provider_first_name, lastName: row.provider_last_name });
    return { dest: row.dest, userId: identity.userId, role: identity.role, created: identity.created };
  });
}

module.exports = { PROVIDER, decideProvisioning, findLink, provisionWithinTxn, redeemAndProvision };
