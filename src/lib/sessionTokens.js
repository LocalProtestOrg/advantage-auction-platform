'use strict';

/**
 * sessionTokens — issuing sign-in tokens and checking them against the server-side session state (migration 194,
 * security audit 2026-10-15, owner-approved).
 *
 * A sign-in token is the same signed JWT as before ({ id, role }) plus:
 *   sv  — the account's users.session_version when the token was issued;
 *   sid — the sign-in lineage id, created at sign-in and KEPT across sliding renewals.
 *
 * A token is refused (treated as signed out) when:
 *   - its sv (missing = 0, so tokens issued before the rollout keep working) differs from users.session_version —
 *     the version is bumped on password reset, account suspension and staff role changes / removal of admin access;
 *   - its sid has been signed out (revoked_sessions). A token from before the rollout has no sid; its lineage id is
 *     derived from the token itself and carried into its renewals, so signing out ends it too.
 * The role used for the request is the CURRENT role in the database, not the one in the token, so a role change takes
 * effect immediately.
 *
 * A short per-session cache bounds the database load. Only a definitive answer is cached; a failed lookup returns
 * "unknown" and the caller keeps its existing behavior (state-changing requests refused with a retry message,
 * read-only requests proceed without renewal). Bumping or signing out clears this instance's cache at once; another
 * instance picks the change up within CACHE_TTL_MS.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../db');

const CACHE_TTL_MS = 15 * 1000;
const CACHE_MAX = 20000;
const LOOKUP_TIMEOUT_MS = 5000;
const cache = new Map(); // `${userId}|${sid}` -> { at, value }

let schemaReady = true; // false only if migration 194 is not applied yet (legacy check, logged once)

function newSid() { return crypto.randomBytes(18).toString('base64url'); }

/** The lineage id of a verified token: its sid, or (for a token from before the rollout) one derived from it. */
function sessionIdOf(decoded, token) {
  if (decoded && typeof decoded.sid === 'string' && decoded.sid) return decoded.sid;
  return 'legacy:' + crypto.createHash('sha256').update(String(token || '')).digest('hex').slice(0, 40);
}

/**
 * Sign a session token. `user` needs id + role; sv defaults to user.session_version (or 0). Pass `sid` to continue an
 * existing sign-in (renewal, role upgrade); omit it for a new sign-in.
 */
function issueToken(user, { sid, sv } = {}) {
  const version = Number.isInteger(sv) ? sv : (Number.isInteger(user.session_version) ? user.session_version : 0);
  return jwt.sign({ id: user.id, role: user.role, sv: version, sid: sid || newSid() }, process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '24h' });
}

function cacheKey(userId, sid) { return String(userId) + '|' + String(sid); }
function cached(userId, sid) {
  const hit = cache.get(cacheKey(userId, sid));
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(cacheKey(userId, sid)); return undefined; }
  return hit.value;
}
function remember(userId, sid, value) {
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(cacheKey(userId, sid), { at: Date.now(), value });
}
function forgetUser(userId) {
  const prefix = String(userId) + '|';
  for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k);
}

async function lookup(userId, sid) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('session lookup timed out')), LOOKUP_TIMEOUT_MS); });
  try {
    if (schemaReady) {
      try {
        const r = await Promise.race([db.query(
          `SELECT u.is_active, u.role, u.session_version,
                  EXISTS (SELECT 1 FROM revoked_sessions s WHERE s.sid = $2) AS revoked
             FROM users u WHERE u.id = $1`, [userId, sid]), timeout]);
        return r && Array.isArray(r.rows) ? r.rows[0] : undefined;
      } catch (e) {
        if (e && e.code === '42703' || e && e.code === '42P01') {
          schemaReady = false;
          console.warn('[session] migration 194 not applied yet — sessions checked for suspension only until it is');
        } else throw e;
      }
    }
    const r = await Promise.race([db.query('SELECT is_active FROM users WHERE id = $1', [userId]), timeout]);
    return r && Array.isArray(r.rows) ? r.rows[0] : undefined;
  } finally { if (timer) clearTimeout(timer); }
}

/**
 * Check a verified token against the server-side session state.
 * Resolves { state, role, sid, sv }:
 *   state 'ok'        — the session is current (role = current database role);
 *   state 'revoked'   — signed out / version bumped: treat as no session;
 *   state 'suspended' — account suspended (is_active = false);
 *   state 'unknown'   — the status could not be determined (no row, lookup error or timeout).
 */
async function checkSession(decoded, token) {
  const sid = sessionIdOf(decoded, token);
  const sv = Number.isInteger(decoded && decoded.sv) ? decoded.sv : 0;
  const base = { sid, sv, role: decoded && decoded.role };
  const userId = decoded && decoded.id;
  if (!userId) return { ...base, state: 'revoked' };
  const hit = cached(userId, sid);
  const decide = (row) => {
    if (!row || typeof row.is_active !== 'boolean') return { ...base, state: 'unknown' };
    const dbVersion = Number.isInteger(row.session_version) ? row.session_version : 0;
    if (row.revoked === true || dbVersion !== sv) return { ...base, state: 'revoked' };
    const role = typeof row.role === 'string' && row.role ? row.role : base.role;
    return { ...base, role, state: row.is_active ? 'ok' : 'suspended' };
  };
  if (hit !== undefined) return decide(hit);
  let row;
  try { row = await lookup(userId, sid); }
  catch (e) { console.warn('[session] lookup failed:', e && e.message); return { ...base, state: 'unknown' }; }
  if (row && typeof row.is_active === 'boolean') remember(userId, sid, row);
  return decide(row);
}

/**
 * End every session of an account (password reset, suspension, staff role change). `runner` may be a transaction
 * client so the bump commits with the change that caused it. Returns the new version (or null before migration 194).
 */
async function endAllSessions(runner, userId, reason) {
  const q = runner || db;
  try {
    const r = await q.query('UPDATE users SET session_version = session_version + 1 WHERE id = $1 RETURNING session_version', [userId]);
    forgetUser(userId);
    if (reason) console.log('[session] all sessions ended:', reason);
    return r.rows[0] ? r.rows[0].session_version : null;
  } catch (e) {
    if (e && e.code === '42703') { console.warn('[session] migration 194 not applied yet — sessions not ended:', reason); return null; }
    throw e;
  }
}

/**
 * Sign a token for a user when only the id and role are at hand (bridge sign-in, claimed listing): reads the current
 * session_version first so the new token is not refused at once after a version bump.
 */
async function issueTokenForUser(userId, role, opts = {}) {
  let sv = 0;
  try {
    const r = await db.query('SELECT session_version FROM users WHERE id = $1', [userId]);
    if (r && r.rows && r.rows[0] && Number.isInteger(r.rows[0].session_version)) sv = r.rows[0].session_version;
  } catch (e) { if (!(e && e.code === '42703')) throw e; }
  return issueToken({ id: userId, role }, { ...opts, sv });
}

/** End one sign-in (sign out). Best-effort: signing out in the browser always succeeds. */
async function endSession(decoded, token, reason = 'logout') {
  if (!decoded || !decoded.id) return false;
  const sid = sessionIdOf(decoded, token);
  try {
    await db.query(`INSERT INTO revoked_sessions (sid, user_id, reason) VALUES ($1, $2, $3) ON CONFLICT (sid) DO NOTHING`, [sid, decoded.id, reason]);
    cache.delete(cacheKey(decoded.id, sid));
    db.query(`DELETE FROM revoked_sessions WHERE revoked_at < now() - interval '2 days'`).catch(() => {});
    return true;
  } catch (e) { console.warn('[session] sign-out not recorded:', e && e.message); return false; }
}

function _clearCache() { cache.clear(); schemaReady = true; }

module.exports = { issueToken, issueTokenForUser, checkSession, forgetUser, endAllSessions, endSession, sessionIdOf, newSid, CACHE_TTL_MS, _clearCache };
