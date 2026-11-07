// #21 Minimal Terms & Conditions service. Versioned terms + idempotent
// acceptance ledger + a gate helper for the server-side bidding gate.
// The ledger is append-only: an acceptance row is never modified or removed, so what someone accepted (and when, from
// which address and browser) stays exactly as recorded. A new version is published as a NEW terms_versions row and
// flipped to is_current; everyone must then accept it before the gates that require the current version let them in.
const db = require('../db');
const { writeAuditLog } = require('../lib/auditLog');

const DEFAULT_KIND = 'buyer_terms';

class TermsError extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status; }
}

// The single current version for a kind (or null if none seeded).
async function getCurrentTerms(kind = DEFAULT_KIND, runner = db) {
  const { rows } = await runner.query(
    `SELECT id, kind, version_int, title, body_markdown, effective_at, created_at,
            includes_sales_near_you
       FROM terms_versions
      WHERE kind = $1 AND is_current = true
      ORDER BY version_int DESC
      LIMIT 1`,
    [kind]
  );
  return rows[0] || null;
}

// True iff the user has accepted the CURRENT version for this kind.
async function hasAcceptedCurrentTerms(userId, kind = DEFAULT_KIND) {
  if (!userId) return false;
  const { rows } = await db.query(
    `SELECT 1
       FROM terms_acceptances ta
       JOIN terms_versions tv ON tv.id = ta.terms_version_id
      WHERE ta.user_id = $1 AND tv.kind = $2 AND tv.is_current = true
      LIMIT 1`,
    [userId, kind]
  );
  return rows.length > 0;
}

// The version the person was shown must still be the current one: accepting "the current version" after it changed
// while their page was open would record agreement to a text they never saw. `expectedVersionInt` is optional (older
// pages do not send it); when sent and different, nothing is recorded and TERMS_CHANGED is raised.
function assertExpectedVersion(current, expectedVersionInt) {
  if (expectedVersionInt == null || expectedVersionInt === '') return;
  if (Number(expectedVersionInt) !== Number(current.version_int)) {
    throw new TermsError('TERMS_CHANGED', 'Our terms were updated while this page was open. Please review the current terms and accept them again.', 409);
  }
}

// Write the acceptance row (idempotent per user + version). `runner` may be a transaction client, so account
// registration creates the account and its acceptance together or not at all. An existing row is never changed.
async function recordAcceptance(runner, userId, current, { ip = null, userAgent = null } = {}) {
  const res = await runner.query(
    `INSERT INTO terms_acceptances (user_id, terms_version_id, ip_address, user_agent)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, terms_version_id) DO NOTHING
     RETURNING id`,
    [userId, current.id, ip, userAgent]
  );
  const row = res.rows && res.rows[0];
  return { acceptance_id: row ? row.id : null, terms_version_id: current.id, version_int: current.version_int, already_accepted: !row };
}

// Side effects of an acceptance, run after any transaction has committed: Sales Near You enrollment for a disclosing
// version (migration 158) and the audit entry. Fire-and-forget and fully guarded: they can never fail an acceptance.
function afterAcceptance(userId, current, result, { kind = DEFAULT_KIND, source = null } = {}) {
  if (current.includes_sales_near_you) {
    Promise.resolve().then(async () => {
      const u = (await db.query('SELECT email, contact_email FROM users WHERE id = $1', [userId])).rows[0];
      if (!u) return;
      await require('./buyerLifecycleEnrollmentService').enroll({
        userId,
        email: (u.contact_email && u.contact_email.trim()) || u.email,
        trigger: 'account_registration',
      });
    }).catch(() => {});
  }
  if (!result.already_accepted && result.acceptance_id) {
    writeAuditLog({
      event_type:  'terms.accepted',
      entity_type: 'terms_acceptance',
      entity_id:   result.acceptance_id,
      actor_id:    userId,
      metadata:    { kind, version_int: current.version_int, terms_version_id: current.id, source },
    }).catch(() => {});
  }
}

// Record acceptance of the current version. Idempotent (UNIQUE(user, version)
// + ON CONFLICT). Returns { terms_version_id, version_int, already_accepted }.
async function acceptCurrentTerms(userId, { kind = DEFAULT_KIND, ip = null, userAgent = null, expectedVersionInt = null, source = null } = {}) {
  const current = await getCurrentTerms(kind);
  if (!current) {
    const err = new Error('No current terms version is configured');
    err.code = 'NO_CURRENT_TERMS';
    throw err;
  }
  assertExpectedVersion(current, expectedVersionInt);
  const result = await recordAcceptance(db, userId, current, { ip, userAgent });
  afterAcceptance(userId, current, result, { kind, source });
  return { terms_version_id: result.terms_version_id, version_int: result.version_int, already_accepted: result.already_accepted };
}

// The ip and user agent recorded with an acceptance, read the same way everywhere (accept route, registration, checkout).
function requestEvidence(req) {
  const h = (req && req.headers) || {};
  const ip = (h['x-forwarded-for'] || (req && req.ip) || '').toString().split(',')[0].trim() || null;
  const userAgent = (h['user-agent'] || '').toString().slice(0, 500) || null;
  return { ip, userAgent };
}

module.exports = { getCurrentTerms, hasAcceptedCurrentTerms, acceptCurrentTerms, recordAcceptance, afterAcceptance,
  assertExpectedVersion, requestEvidence, TermsError, DEFAULT_KIND };
