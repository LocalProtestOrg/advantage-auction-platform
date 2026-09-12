'use strict';

/**
 * authorizationService — the Event Partner authorization registry and its state machine.
 *
 * What this service is for: recording, with evidence, that a named company gave Advantage.Bid
 * permission to collect the events it posts publicly on its own website and to promote them for free.
 *
 * Non-negotiables enforced here:
 *   1. Authorization is never INFERRED. A directory listing, a BD import, an existing claim or an
 *      email address in our CRM grants nothing. Only an explicit recorded act sets 'authorized'.
 *   2. Granting is single-use and atomic. The token consume is a conditional UPDATE, so two
 *      simultaneous presentations of the same link cannot both succeed.
 *   3. Authorization is NOT marketing-email permission, NOT an unsubscribe, NOT listing ownership and
 *      NOT seller activation. This service touches none of those tables.
 *   4. Authorizing makes collection ELIGIBLE. It never creates, configures or starts an import source
 *      — that is a separate, validated admin action (see importSourceService).
 *   5. Revocation is terminal and always disables the attached source.
 *
 * Nine states: prospective, invited, declined, expired, authorized, source_configured, collecting,
 * paused, revoked. See migration 153 for the meaning of each.
 */

const db = require('../../db');
const { withTransaction } = require('../../utils/withTransaction');
const auditService = require('../auditService');
const configService = require('../configService');
const { normalizeEmail } = require('../../lib/emailNormalize');
const statement = require('./authorizationStatement');
const tokens = require('./tokens');

function err(status, code, message) {
  const e = new Error(message); e.status = status; e.code = code; e.expose = true; return e;
}

const STATES = Object.freeze([
  'prospective', 'invited', 'declined', 'expired', 'authorized',
  'source_configured', 'collecting', 'paused', 'revoked',
]);

// Terminal states never transition again (a company is re-engaged with a NEW registry row).
const TERMINAL = Object.freeze(['revoked', 'declined', 'expired']);

// The only permitted moves. Anything absent here is refused with INVALID_TRANSITION rather than
// silently applied, so an unexpected code path can never quietly advance a company's status.
const TRANSITIONS = Object.freeze({
  prospective:       ['invited', 'authorized', 'declined', 'revoked'],
  invited:           ['authorized', 'declined', 'expired', 'invited', 'revoked'],
  authorized:        ['source_configured', 'paused', 'revoked'],
  source_configured: ['collecting', 'paused', 'revoked'],
  collecting:        ['paused', 'revoked'],
  paused:            ['collecting', 'source_configured', 'authorized', 'revoked'],
  declined:          [],
  expired:           ['invited'],
  revoked:           [],
});

/** States in which a company has actually granted permission (collection may legitimately exist). */
const AUTHORIZED_STATES = Object.freeze(['authorized', 'source_configured', 'collecting', 'paused']);

function canTransition(from, to) {
  return !!(TRANSITIONS[from] && TRANSITIONS[from].indexOf(to) !== -1);
}

/**
 * Registrable host for a website. Accepts a bare domain or a full URL, strips scheme, credentials,
 * port, path and a leading "www.". Returns null when nothing usable is present — we never invent a
 * domain, because the domain IS the unit of permission.
 */
function normalizeDomain(input) {
  if (!input) return null;
  let s = String(input).trim().toLowerCase();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = 'http://' + s;
  let host;
  try { host = new URL(s).hostname; } catch (_) { return null; }
  if (!host) return null;
  host = host.replace(/^www\./, '').replace(/\.$/, '');
  // A registrable host needs at least one dot and no whitespace/underscore oddities.
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  return host;
}

const q = (client) => (client || db);

// ── Reads ────────────────────────────────────────────────────────────────────────────────────

async function getById(id, client) {
  const { rows } = await q(client).query('SELECT * FROM authorized_event_sources WHERE id = $1', [id]);
  return rows[0] || null;
}

/** Every registry row for an organization, newest first. */
async function listForOrganization(organizationId, client) {
  const { rows } = await q(client).query(
    'SELECT * FROM authorized_event_sources WHERE organization_id = $1 ORDER BY created_at DESC', [organizationId]);
  return rows;
}

/**
 * Is this organization an Event Partner (has any non-terminal registry row)? Used by the claim
 * security layer: a company we invited must never be exposed to weaker claim proof.
 */
async function isEventPartnerOrganization(organizationId, client) {
  if (!organizationId) return false;
  const { rows } = await q(client).query(
    `SELECT 1 FROM authorized_event_sources
      WHERE organization_id = $1 AND status NOT IN ('revoked','declined','expired') LIMIT 1`, [organizationId]);
  return rows.length > 0;
}

/** Admin/dashboard listing with the joined facts an operator needs to judge a partner at a glance. */
async function list(opts, client) {
  opts = opts || {};
  const params = []; const where = [];
  if (opts.status) { params.push(opts.status); where.push(`a.status = $${params.length}`); }
  if (opts.organizationId) { params.push(opts.organizationId); where.push(`a.organization_id = $${params.length}`); }
  if (opts.q) { params.push('%' + String(opts.q).trim() + '%'); where.push(`(a.company_name ILIKE $${params.length} OR a.authorized_domain ILIKE $${params.length})`); }
  params.push(Math.min(Math.max(parseInt(opts.limit, 10) || 50, 1), 200));
  const limitIdx = params.length;
  params.push(Math.max(parseInt(opts.offset, 10) || 0, 0));
  const { rows } = await q(client).query(
    `SELECT a.*,
            o.slug  AS org_slug, o.city AS org_city, o.state AS org_state,
            o.lifecycle_state AS org_lifecycle, o.website_url AS org_website,
            s.key AS source_key, s.status AS source_status, s.kind AS source_kind,
            (SELECT count(*)::int FROM events e
              WHERE e.host_organization_id = a.organization_id) AS event_count,
            (SELECT count(*)::int FROM events e
              WHERE e.host_organization_id = a.organization_id
                AND e.status = 'published' AND (e.end_at IS NULL OR e.end_at >= now())) AS live_event_count,
            (SELECT count(*)::int FROM organization_members m
              WHERE m.organization_id = a.organization_id AND m.role = 'owner' AND m.status = 'active') AS owner_count
       FROM authorized_event_sources a
       JOIN organizations o ON o.id = a.organization_id
       LEFT JOIN import_sources s ON s.id = a.import_source_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY a.updated_at DESC
      LIMIT $${limitIdx} OFFSET $${limitIdx + 1}`, params);
  return rows;
}

/** The audit trail for one authorization, straight from the shared audit_log. */
async function auditHistory(authorizationId, client) {
  const { rows } = await q(client).query(
    `SELECT event_type, actor_id, metadata, created_at FROM audit_log
      WHERE entity_type = 'authorized_event_source' AND entity_id = $1
      ORDER BY created_at DESC LIMIT 200`, [authorizationId]);
  return rows;
}

// ── Registry writes ──────────────────────────────────────────────────────────────────────────

/**
 * Create a registry row for a company we intend to invite. Starts at 'prospective' — creating the
 * record grants NOTHING. The organization must already exist (we never mint companies here).
 */
async function createInvitation(input) {
  input = input || {};
  const organizationId = input.organizationId;
  if (!organizationId) throw err(400, 'ORG_REQUIRED', 'An organization is required.');
  const domain = normalizeDomain(input.domain || input.websiteUrl);
  if (!domain) throw err(400, 'DOMAIN_REQUIRED', 'A valid company website is required.');
  const invitedEmail = input.invitedEmail ? String(input.invitedEmail).trim() : null;
  const invitedNorm = invitedEmail ? normalizeEmail(invitedEmail) : null;
  if (invitedEmail && !invitedNorm) throw err(400, 'INVALID_EMAIL', 'The invited email address is not valid.');

  return withTransaction(async (client) => {
    const org = (await client.query('SELECT id, name FROM organizations WHERE id = $1', [organizationId])).rows[0];
    if (!org) throw err(404, 'ORG_NOT_FOUND', 'Organization not found.');
    const companyName = (input.companyName || org.name || '').trim();
    if (!companyName) throw err(400, 'COMPANY_NAME_REQUIRED', 'A company name is required.');

    // One live authorization per (org, domain) — the partial unique index is the real guard; this
    // read turns the race loser into a clear error instead of a constraint violation.
    const existing = (await client.query(
      `SELECT id, status FROM authorized_event_sources
        WHERE organization_id = $1 AND authorized_domain = $2
          AND status NOT IN ('revoked','declined','expired') LIMIT 1`, [organizationId, domain])).rows[0];
    if (existing) throw err(409, 'ALREADY_REGISTERED', `This company and website already have a live authorization record (status: ${existing.status}).`);

    const { rows } = await client.query(
      `INSERT INTO authorized_event_sources
         (organization_id, company_name, authorized_domain, authorized_source_url,
          invited_email, invited_email_normalized, status, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'prospective',$7,$8) RETURNING *`,
      [organizationId, companyName, domain, input.sourceUrl || null,
       invitedEmail, invitedNorm, input.notes || null, input.actorId || null]);
    const row = rows[0];
    await auditService.logEvent(client, {
      eventType: 'event_partner.registered', entityType: 'authorized_event_source', entityId: row.id,
      actorId: input.actorId || null,
      metadata: { organization_id: organizationId, domain, company_name: companyName, status: 'prospective' },
    });
    return row;
  });
}

/** Internal: apply a state change with the transition guard + audit, inside an existing transaction. */
async function transition(client, row, nextStatus, actorId, meta) {
  if (!canTransition(row.status, nextStatus)) {
    throw err(409, 'INVALID_TRANSITION', `Cannot move an authorization from '${row.status}' to '${nextStatus}'.`);
  }
  const { rows } = await client.query(
    'UPDATE authorized_event_sources SET status = $2, updated_at = now() WHERE id = $1 RETURNING *',
    [row.id, nextStatus]);
  await auditService.logEvent(client, {
    eventType: 'event_partner.status_changed', entityType: 'authorized_event_source', entityId: row.id,
    actorId: actorId || null,
    metadata: Object.assign({ from: row.status, to: nextStatus }, meta || {}),
  });
  return rows[0];
}

// ── Authorization tokens ─────────────────────────────────────────────────────────────────────

/**
 * Mint a single-use authorization link for a registry row and move it to 'invited'.
 *
 * Returns the RAW token exactly once — it is not stored and cannot be recovered. Phase 1 has no
 * sender, so the caller (an administrator) receives the link and nothing is emailed. Any previously
 * unused token for this authorization is invalidated first, so only one live link can ever exist.
 */
async function issueAuthorizationToken(authorizationId, opts) {
  opts = opts || {};
  return withTransaction(async (client) => {
    const row = (await client.query(
      'SELECT * FROM authorized_event_sources WHERE id = $1 FOR UPDATE', [authorizationId])).rows[0];
    if (!row) throw err(404, 'NOT_FOUND', 'Authorization record not found.');
    if (TERMINAL.indexOf(row.status) !== -1 && row.status !== 'expired') {
      throw err(409, 'TERMINAL_STATE', `This authorization is ${row.status} and cannot be re-issued.`);
    }
    if (AUTHORIZED_STATES.indexOf(row.status) !== -1) {
      throw err(409, 'ALREADY_AUTHORIZED', 'This company has already authorized event promotion.');
    }

    // Exactly one live link at a time: burn any outstanding unused token for this authorization.
    await client.query(
      `UPDATE event_partner_authorization_tokens
          SET used_at = now(), used_user_agent = 'superseded'
        WHERE authorization_id = $1 AND used_at IS NULL`, [authorizationId]);

    const ttlDays = opts.ttlDays != null ? opts.ttlDays
      : (await configService.get(null, 'event_partners.token_ttl_days')) || 30;
    const raw = tokens.mintToken();
    const expiresAt = tokens.expiresInDays(ttlDays);
    const recipient = opts.recipientEmail ? normalizeEmail(opts.recipientEmail) : row.invited_email_normalized;

    const tok = (await client.query(
      `INSERT INTO event_partner_authorization_tokens
         (authorization_id, organization_id, token_hash, recipient_email_normalized, purpose, expires_at, issued_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, expires_at`,
      [authorizationId, row.organization_id, tokens.hashToken(raw), recipient || null,
       opts.purpose || 'authorize', expiresAt, opts.actorId || null])).rows[0];

    if (row.status !== 'invited') await transition(client, row, 'invited', opts.actorId, { via: 'token_issued' });
    else await client.query('UPDATE authorized_event_sources SET updated_at = now() WHERE id = $1', [authorizationId]);

    await auditService.logEvent(client, {
      eventType: 'event_partner.token_issued', entityType: 'authorized_event_source', entityId: authorizationId,
      actorId: opts.actorId || null,
      // The token id and expiry are auditable; the raw token never appears in the log.
      metadata: { token_id: tok.id, expires_at: tok.expires_at, recipient_bound: !!recipient, purpose: opts.purpose || 'authorize' },
    });
    return { token: raw, tokenId: tok.id, expiresAt: tok.expires_at, authorizationId };
  });
}

/**
 * Look up a presented token WITHOUT consuming it — for rendering the confirmation page (a GET must
 * never change state). Returns a sanitized view or a machine reason. A malformed token never reaches
 * the database. Failed presentations increment `attempts` so brute force is visible.
 */
async function previewToken(raw, client) {
  if (!tokens.isWellFormed(raw)) return { ok: false, reason: 'invalid' };
  const hash = tokens.hashToken(raw);
  const { rows } = await q(client).query(
    `SELECT t.*, a.company_name, a.authorized_domain, a.status AS auth_status, a.organization_id
       FROM event_partner_authorization_tokens t
       JOIN authorized_event_sources a ON a.id = t.authorization_id
      WHERE t.token_hash = $1`, [hash]);
  const t = rows[0];
  if (!t) return { ok: false, reason: 'invalid' };
  await q(client).query(
    'UPDATE event_partner_authorization_tokens SET attempts = attempts + 1 WHERE id = $1', [t.id]).catch(() => {});
  if (t.used_at) return { ok: false, reason: 'already_used', companyName: t.company_name };
  if (new Date(t.expires_at).getTime() <= Date.now()) return { ok: false, reason: 'expired', companyName: t.company_name };
  if (AUTHORIZED_STATES.indexOf(t.auth_status) !== -1) return { ok: false, reason: 'already_authorized', companyName: t.company_name };
  if (TERMINAL.indexOf(t.auth_status) !== -1 && t.auth_status !== 'expired') return { ok: false, reason: 'not_available', companyName: t.company_name };
  return {
    ok: true,
    authorizationId: t.authorization_id,
    organizationId: t.organization_id,
    companyName: t.company_name,
    domain: t.authorized_domain,
    purpose: t.purpose,
    expiresAt: t.expires_at,
    statement: statement.build({ companyName: t.company_name, domain: t.authorized_domain }),
  };
}

/**
 * Consume a token and grant authorization. This is the POST target of the confirmation page.
 *
 * Single-use and replay-safe: the token is claimed with a conditional UPDATE that only matches a row
 * whose used_at IS NULL and which has not expired. If that UPDATE affects zero rows, another request
 * already won, and this one is refused — the check and the claim cannot drift apart.
 *
 * Grants ONLY the event-collection permission. No account, no capability, no membership, no mailing
 * list, and no import source is created here.
 */
async function authorizeWithToken(raw, ctx) {
  ctx = ctx || {};
  if (!tokens.isWellFormed(raw)) throw err(400, 'INVALID_TOKEN', 'This authorization link is not valid.');
  if (ctx.agreed !== true) throw err(400, 'CONFIRMATION_REQUIRED', 'Please confirm to authorize.');
  const hash = tokens.hashToken(raw);

  return withTransaction(async (client) => {
    // Atomic single-use claim. Expiry is evaluated in the same statement as the claim.
    const claimed = (await client.query(
      `UPDATE event_partner_authorization_tokens
          SET used_at = now(), used_ip_hash = $2, used_user_agent = $3
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
        RETURNING *`,
      [hash, tokens.hashIp(ctx.ip), (ctx.userAgent || '').slice(0, 256) || null])).rows[0];
    if (!claimed) {
      // Distinguish "never existed" from "already used / expired" for an honest page message, without
      // revealing anything a holder of the link does not already know.
      const probe = (await client.query(
        'SELECT used_at, expires_at FROM event_partner_authorization_tokens WHERE token_hash = $1', [hash])).rows[0];
      if (!probe) throw err(404, 'INVALID_TOKEN', 'This authorization link is not valid.');
      if (probe.used_at) throw err(409, 'ALREADY_USED', 'This authorization link has already been used.');
      throw err(410, 'EXPIRED', 'This authorization link has expired.');
    }
    if (claimed.purpose !== 'authorize') throw err(400, 'WRONG_PURPOSE', 'This link cannot be used to authorize.');

    const row = (await client.query(
      'SELECT * FROM authorized_event_sources WHERE id = $1 FOR UPDATE', [claimed.authorization_id])).rows[0];
    if (!row) throw err(404, 'NOT_FOUND', 'Authorization record not found.');
    if (AUTHORIZED_STATES.indexOf(row.status) !== -1) throw err(409, 'ALREADY_AUTHORIZED', 'This company has already authorized event promotion.');

    const snapshot = statement.evidenceSnapshot({ companyName: row.company_name, domain: row.authorized_domain });
    const evidence = {
      statement: snapshot,
      token_id: claimed.id,
      recipient_bound: !!claimed.recipient_email_normalized,
      recipient_email_normalized: claimed.recipient_email_normalized || null,
      confirmed_via: 'post_confirmation',
      request: {
        ip_hash: tokens.hashIp(ctx.ip),
        user_agent: (ctx.userAgent || '').slice(0, 256) || null,
        origin: (ctx.origin || '').slice(0, 200) || null,
        at: new Date().toISOString(),
      },
    };

    const updated = (await client.query(
      `UPDATE authorized_event_sources
          SET status = 'authorized', authorization_method = 'one_click_email',
              authorized_at = now(), authorized_ip_hash = $2, authorized_user_agent = $3,
              authorization_statement_version = $4, authorization_evidence = $5::jsonb, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [row.id, tokens.hashIp(ctx.ip), (ctx.userAgent || '').slice(0, 256) || null,
       snapshot.statement_version, JSON.stringify(evidence)])).rows[0];

    await auditService.logEvent(client, {
      eventType: 'event_partner.authorized', entityType: 'authorized_event_source', entityId: row.id,
      actorId: null,   // the company acted, not a platform user
      metadata: {
        organization_id: row.organization_id, domain: row.authorized_domain,
        method: 'one_click_email', statement_version: snapshot.statement_version,
        token_id: claimed.id, from: row.status,
      },
    });
    return updated;
  });
}

/**
 * Record an authorization that happened outside the link flow (an administrator transcribing a
 * countersigned agreement, a phone/inbound request). Evidence is REQUIRED — there is no way to mark a
 * company authorized without saying what the proof was and who recorded it.
 */
async function recordOfflineAuthorization(authorizationId, input) {
  input = input || {};
  const method = input.method;
  if (['admin_recorded', 'written_agreement', 'inbound_request'].indexOf(method) === -1) {
    throw err(400, 'INVALID_METHOD', 'An offline authorization needs a recognized method.');
  }
  const evidenceText = String(input.evidence || '').trim();
  if (evidenceText.length < 10) throw err(400, 'EVIDENCE_REQUIRED', 'Describe the evidence for this authorization (at least 10 characters).');
  if (!input.actorId) throw err(401, 'ACTOR_REQUIRED', 'An acting administrator is required.');

  return withTransaction(async (client) => {
    const row = (await client.query(
      'SELECT * FROM authorized_event_sources WHERE id = $1 FOR UPDATE', [authorizationId])).rows[0];
    if (!row) throw err(404, 'NOT_FOUND', 'Authorization record not found.');
    if (AUTHORIZED_STATES.indexOf(row.status) !== -1) throw err(409, 'ALREADY_AUTHORIZED', 'This company has already authorized event promotion.');
    if (!canTransition(row.status, 'authorized')) throw err(409, 'INVALID_TRANSITION', `Cannot authorize from '${row.status}'.`);

    const snapshot = statement.evidenceSnapshot({ companyName: row.company_name, domain: row.authorized_domain });
    const evidence = {
      statement: snapshot,
      recorded_by: input.actorId,
      recorded_at: new Date().toISOString(),
      method,
      description: evidenceText,
      document_url: input.documentUrl || null,
      contact_name: input.contactName || null,
    };
    const updated = (await client.query(
      `UPDATE authorized_event_sources
          SET status = 'authorized', authorization_method = $2, authorized_at = now(),
              authorization_statement_version = $3, authorization_evidence = $4::jsonb, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [authorizationId, method, snapshot.statement_version, JSON.stringify(evidence)])).rows[0];
    await auditService.logEvent(client, {
      eventType: 'event_partner.authorized', entityType: 'authorized_event_source', entityId: authorizationId,
      actorId: input.actorId,
      metadata: { method, from: row.status, organization_id: row.organization_id, domain: row.authorized_domain },
    });
    return updated;
  });
}

/** The company said no. Terminal, and recorded as such — never quietly left 'invited'. */
async function decline(authorizationId, input) {
  input = input || {};
  return withTransaction(async (client) => {
    const row = (await client.query(
      'SELECT * FROM authorized_event_sources WHERE id = $1 FOR UPDATE', [authorizationId])).rows[0];
    if (!row) throw err(404, 'NOT_FOUND', 'Authorization record not found.');
    const updated = await transition(client, row, 'declined', input.actorId, { reason: input.reason || null });
    await auditService.logEvent(client, {
      eventType: 'event_partner.declined', entityType: 'authorized_event_source', entityId: authorizationId,
      actorId: input.actorId || null, metadata: { reason: input.reason || null },
    });
    return updated;
  });
}

/**
 * Withdraw permission. Terminal, immediate, and it ALWAYS disables the attached import source in the
 * same transaction — a revoked company can never be collected from again by an existing source row.
 *
 * Deliberately separate from an email unsubscribe: revoking collection says nothing about email
 * permission, and unsubscribing from email says nothing about collection. Neither touches the other.
 */
async function revoke(authorizationId, input) {
  input = input || {};
  return withTransaction(async (client) => {
    const row = (await client.query(
      'SELECT * FROM authorized_event_sources WHERE id = $1 FOR UPDATE', [authorizationId])).rows[0];
    if (!row) throw err(404, 'NOT_FOUND', 'Authorization record not found.');
    if (row.status === 'revoked') return row;   // idempotent: revoking twice is not an error

    if (row.import_source_id) {
      await client.query(
        "UPDATE import_sources SET status = 'disabled', updated_at = now() WHERE id = $1", [row.import_source_id]);
    }
    const { rows } = await client.query(
      `UPDATE authorized_event_sources
          SET status = 'revoked', revoked_at = now(), revoked_reason = $2, revoked_by = $3, revoked_via = $4,
              updated_at = now()
        WHERE id = $1 RETURNING *`,
      [authorizationId, input.reason || null, input.actorId || null, input.via || 'admin']);
    await auditService.logEvent(client, {
      eventType: 'event_partner.revoked', entityType: 'authorized_event_source', entityId: authorizationId,
      actorId: input.actorId || null,
      metadata: {
        from: row.status, via: input.via || 'admin', reason: input.reason || null,
        import_source_disabled: row.import_source_id || null, organization_id: row.organization_id,
      },
    });
    return rows[0];
  });
}

/** Mark lapsed invitations expired. Read-only on companies; only touches rows whose links are dead. */
async function expireLapsedInvitations(client) {
  const { rows } = await q(client).query(
    `UPDATE authorized_event_sources a
        SET status = 'expired', updated_at = now()
      WHERE a.status = 'invited'
        AND NOT EXISTS (
          SELECT 1 FROM event_partner_authorization_tokens t
           WHERE t.authorization_id = a.id AND t.used_at IS NULL AND t.expires_at > now())
      RETURNING id`);
  return rows.map((r) => r.id);
}

module.exports = {
  STATES, TERMINAL, TRANSITIONS, AUTHORIZED_STATES, canTransition, normalizeDomain,
  getById, list, listForOrganization, isEventPartnerOrganization, auditHistory,
  createInvitation, issueAuthorizationToken, previewToken, authorizeWithToken,
  recordOfflineAuthorization, decline, revoke, expireLapsedInvitations, transition,
};
