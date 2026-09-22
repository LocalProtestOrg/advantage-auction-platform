// #21 Minimal Terms & Conditions service. Versioned terms + idempotent
// acceptance ledger + a gate helper for the (future) server-side bidding gate.
const db = require('../db');
const { writeAuditLog } = require('../lib/auditLog');

const DEFAULT_KIND = 'buyer_terms';

// The single current version for a kind (or null if none seeded).
async function getCurrentTerms(kind = DEFAULT_KIND) {
  const { rows } = await db.query(
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

// Record acceptance of the current version. Idempotent (UNIQUE(user, version)
// + ON CONFLICT). Returns { terms_version_id, version_int, already_accepted }.
async function acceptCurrentTerms(userId, { kind = DEFAULT_KIND, ip = null, userAgent = null } = {}) {
  const current = await getCurrentTerms(kind);
  if (!current) {
    const err = new Error('No current terms version is configured');
    err.code = 'NO_CURRENT_TERMS';
    throw err;
  }
  const res = await db.query(
    `INSERT INTO terms_acceptances (user_id, terms_version_id, ip_address, user_agent)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, terms_version_id) DO NOTHING
     RETURNING id`,
    [userId, current.id, ip, userAgent]
  );
  const alreadyAccepted = res.rowCount === 0;

  // Sales Near You (migration 158). Accepting a version that DISCLOSES the benefit is the earliest
  // moment the relationship may honestly be established — account creation accepts no terms, so
  // nothing is disclosed there and nothing is enrolled there. Fire-and-forget and fully guarded:
  // a marketing side effect must never be able to fail a terms acceptance.
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

  if (!alreadyAccepted) {
    // Non-blocking audit; failure must not break acceptance.
    writeAuditLog({
      event_type:  'terms.accepted',
      entity_type: 'terms_acceptance',
      entity_id:   res.rows[0].id,
      actor_id:    userId,
      metadata:    { kind, version_int: current.version_int, terms_version_id: current.id },
    }).catch(() => {});
  }
  return { terms_version_id: current.id, version_int: current.version_int, already_accepted: alreadyAccepted };
}

module.exports = { getCurrentTerms, hasAcceptedCurrentTerms, acceptCurrentTerms, DEFAULT_KIND };
