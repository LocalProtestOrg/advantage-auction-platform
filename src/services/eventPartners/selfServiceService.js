'use strict';

/**
 * selfServiceService — the lightweight trust ladder for a company that finds Advantage.Bid itself.
 *
 * Owner policy (docs/projects/event-partner-self-service-verification.md): no ordinary estate sale
 * company or auction house should have to understand DNS, upload a verification file, or perform
 * domain administration just to let us promote its public events. Friction is not created because
 * abuse is theoretically possible.
 *
 * The abuse that actually matters is narrow: somebody authorizing a website that is not theirs, most
 * damagingly a competitor's. The ladder is calibrated to exactly that and nothing more.
 *
 *   Path A  domain match          requester@company.com for company.com  → straight to authorization
 *   Path B  official contact      personal mailbox → confirm via the address published on the
 *                                 company's OWN website (primary fallback)
 *   Path C  trusted relationship  an existing claimed listing / verified seller / org member
 *   Path D  admin review          no company email findable → a person looks at it
 *   Path E  blocked               genuinely concerning signals → a person looks at it
 *
 * The invariant that survives all of it: the ladder decides whether an authorization LINK may be
 * issued. It never is the authorization. Permission is still recorded only by the deterministic,
 * single-use, evidence-backed Phase 1 grant, and `authorization_method` keeps its four approved
 * evidence types.
 */

const db = require('../../db');
const { withTransaction } = require('../../utils/withTransaction');
const auditService = require('../auditService');
const configService = require('../configService');
const { normalizeEmail } = require('../../lib/emailNormalize');
const tokens = require('./tokens');
const authorization = require('./authorizationService');
const claimSecurity = require('../organizationClaimSecurityService');
const escalations = require('./escalationService');

function err(status, code, message) {
  const e = new Error(message); e.status = status; e.code = code; e.expose = true; return e;
}
const q = (client) => (client || db);

const PATHS = Object.freeze(['a_domain_match', 'b_official_contact', 'c_trusted_relationship', 'd_admin_review', 'e_blocked']);

// Reuse the free-mailbox list already curated for claim security — one source of truth for
// "this address proves nothing about a company".
const FREE_MAILBOXES = claimSecurity.PUBLIC_EMAIL_DOMAINS;

/** The registrable host of an email address. */
function emailDomain(email) {
  const n = normalizeEmail(email);
  if (!n) return null;
  return (n.split('@')[1] || '').replace(/^www\./, '') || null;
}

/** Does the requester's mailbox sit on the company's own website domain (or a subdomain of it)? */
function domainMatches(requesterEmail, siteDomain) {
  const d = emailDomain(requesterEmail);
  if (!d || !siteDomain) return false;
  if (FREE_MAILBOXES.has(d)) return false;     // a free mailbox never matches, however it looks
  return d === siteDomain || d.endsWith('.' + siteDomain);
}

// ── Signal gathering ────────────────────────────────────────────────────────────────────────────

/**
 * Look for concerning signals (Path E). Deliberately short: only things that genuinely indicate the
 * request may not be the company's own, not a general suspicion budget.
 */
async function gatherRiskSignals(client, domain, requesterEmail) {
  const risks = [];

  // Is this domain already the authorized website of a DIFFERENT live partner?
  const live = (await q(client).query(
    `SELECT a.id, a.organization_id, a.company_name, a.status
       FROM authorized_event_sources a
      WHERE a.authorized_domain = $1 AND a.status NOT IN ('revoked','declined','expired')
      LIMIT 1`, [domain])).rows[0];
  if (live) risks.push({ code: 'domain_already_authorized', detail: { status: live.status, company: live.company_name } });

  // Does an organization already own this website AND have a verified owner? Then a stranger asking
  // to authorize it is exactly the case this check exists for.
  const owned = (await q(client).query(
    `SELECT o.id, o.name, o.lifecycle_state,
            (SELECT count(*)::int FROM organization_members m
              WHERE m.organization_id = o.id AND m.role = 'owner' AND m.status = 'active') AS owners
       FROM organizations o
      WHERE lower(regexp_replace(regexp_replace(coalesce(o.website_url,''), '^https?://', '', 'i'), '^www\\.', '')) LIKE $1 || '%'
      LIMIT 1`, [domain])).rows[0];
  if (owned && owned.owners > 0) {
    risks.push({ code: 'domain_belongs_to_claimed_organization', detail: { organization: owned.name } });
  }

  // Several unrelated requesters converging on one domain in a short window.
  const contenders = (await q(client).query(
    `SELECT count(DISTINCT requester_email_normalized)::int n
       FROM event_partner_requests
      WHERE requested_domain = $1 AND created_at > now() - interval '30 days'`, [domain])).rows[0].n;
  if (contenders >= 3) risks.push({ code: 'multiple_requesters_same_domain', detail: { distinct_requesters: contenders } });

  // A burst from one mailbox across many companies.
  const norm = normalizeEmail(requesterEmail);
  if (norm) {
    const spread = (await q(client).query(
      `SELECT count(DISTINCT requested_domain)::int n
         FROM event_partner_requests
        WHERE requester_email_normalized = $1 AND created_at > now() - interval '7 days'`, [norm])).rows[0].n;
    if (spread >= 5) risks.push({ code: 'requester_many_domains', detail: { distinct_domains: spread } });
  }
  return { risks, liveAuthorization: live || null, ownedOrganization: owned || null };
}

/**
 * Path C: is the requester already trusted for this company? Any of a claimed listing they own, an
 * active organization membership, or a verified seller profile linked to the organization.
 */
async function findTrustedRelationship(client, domain, requesterEmail) {
  const norm = normalizeEmail(requesterEmail);
  if (!norm) return null;
  const { rows } = await q(client).query(
    `SELECT o.id AS organization_id, o.name, o.lifecycle_state, m.role, u.id AS user_id, u.email_verified
       FROM users u
       JOIN organization_members m ON m.user_id = u.id AND m.status = 'active'
       JOIN organizations o ON o.id = m.organization_id
      WHERE lower(u.email) = $1
        AND lower(regexp_replace(regexp_replace(coalesce(o.website_url,''), '^https?://', '', 'i'), '^www\\.', '')) LIKE $2 || '%'
      LIMIT 1`, [norm, domain]);
  const hit = rows[0];
  if (!hit) return null;
  // A membership on an unverified email is not a trusted relationship.
  if (hit.email_verified !== true) return null;
  return hit;
}

/** Match the requested website to an existing organization record (directory listing included). */
async function matchOrganization(client, domain) {
  const { rows } = await q(client).query(
    `SELECT id, name, slug, lifecycle_state, contact_email, website_url, city, state
       FROM organizations
      WHERE lower(regexp_replace(regexp_replace(coalesce(website_url,''), '^https?://', '', 'i'), '^www\\.', '')) LIKE $1 || '%'
      ORDER BY (source = 'bd_import') DESC LIMIT 1`, [domain]);
  return rows[0] || null;
}

/**
 * Find an official contact address published by the company itself (Path B). Phase 2A resolves this
 * from information we ALREADY hold — the mirrored directory record's contact address — and verifies
 * it is on the company's own domain. Fetching the company's live website for a mailto: is a Phase 2B
 * addition; it is deliberately not done here because Phase 2A must not begin retrieving company sites.
 */
async function findOfficialContact(client, domain, organization) {
  const candidate = organization && organization.contact_email;
  const d = emailDomain(candidate);
  if (!d) return null;
  if (FREE_MAILBOXES.has(d)) return null;                      // a company gmail is not "official"
  if (d !== domain && !d.endsWith('.' + domain)) return null;   // must be ON the authorized domain
  return { email: candidate, source: 'directory_record' };
}

// ── The ladder ──────────────────────────────────────────────────────────────────────────────────

/**
 * evaluate(input) → the decision, WITHOUT writing anything. Exported separately so the decision can
 * be unit-tested and so an administrator can see why a request landed where it did.
 */
async function evaluate(input, client) {
  input = input || {};
  const domain = authorization.normalizeDomain(input.companyWebsite);
  if (!domain) throw err(400, 'INVALID_WEBSITE', 'Enter your company website.');
  const requesterEmail = normalizeEmail(input.requesterEmail);
  if (!requesterEmail) throw err(400, 'INVALID_EMAIL', 'Enter a valid email address.');

  const signals = { domain, requester_domain: emailDomain(requesterEmail) };
  const { risks, liveAuthorization, ownedOrganization } = await gatherRiskSignals(client, domain, requesterEmail);
  signals.risks = risks;

  const organization = await matchOrganization(client, domain);
  if (organization) signals.matched_organization = { id: organization.id, name: organization.name, lifecycle: organization.lifecycle_state };

  // Path C first when it applies: an existing trusted relationship should never be asked to prove
  // itself again.
  const trusted = await findTrustedRelationship(client, domain, requesterEmail);
  if (trusted) {
    signals.trusted_relationship = { organization_id: trusted.organization_id, role: trusted.role };
    return { path: 'c_trusted_relationship', domain, requesterEmail, organization, signals,
      nextStatus: 'verified', verifiedVia: 'trusted_relationship' };
  }

  // Path E: genuinely concerning. Only the two risks that indicate the request may not be the
  // company's own force a block; volume signals inform a human but do not by themselves block.
  const blocking = risks.filter((r) => ['domain_already_authorized', 'domain_belongs_to_claimed_organization'].indexOf(r.code) !== -1);
  if (blocking.length) {
    return { path: 'e_blocked', domain, requesterEmail, organization, signals,
      nextStatus: 'needs_admin', blockingRisks: blocking,
      liveAuthorization: liveAuthorization ? { id: liveAuthorization.id } : null };
  }

  // Path A: the easy, common, intended case. No ceremony.
  if (domainMatches(requesterEmail, domain)) {
    signals.domain_match = true;
    return { path: 'a_domain_match', domain, requesterEmail, organization, signals,
      nextStatus: 'verified', verifiedVia: 'domain_match' };
  }

  // Path B: the primary fallback — confirm via the company's own published address.
  const official = await findOfficialContact(client, domain, organization);
  if (official) {
    signals.official_contact_found = { source: official.source };
    return { path: 'b_official_contact', domain, requesterEmail, organization, signals,
      nextStatus: 'awaiting_company_confirmation', officialContact: official };
  }

  // Path D: nothing findable. A person looks at it — never a DNS record.
  return { path: 'd_admin_review', domain, requesterEmail, organization, signals, nextStatus: 'needs_admin' };
}

/**
 * submit(input) — record a public request and place it on the ladder.
 *
 * Writes a request row and, for Path B, mints the hashed single-use confirmation token. It does NOT
 * send the confirmation email: Phase 2A has no sender enabled, so the token and its target are
 * recorded and the send is left for Phase 2B. Nothing here creates an authorization.
 */
async function submit(input) {
  input = input || {};
  const enabled = await configService.get(null, 'event_partners.self_service_enabled');
  if (enabled !== true) throw err(404, 'NOT_AVAILABLE', 'This form is not available yet.');
  if (!String(input.companyName || '').trim()) throw err(400, 'COMPANY_REQUIRED', 'Enter your company name.');

  return withTransaction(async (client) => {
    const decision = await evaluate(input, client);
    const { rows } = await client.query(
      `INSERT INTO event_partner_requests
         (company_name, company_website, requested_domain, requester_name,
          requester_email, requester_email_normalized, trust_path, status,
          official_contact_email, official_contact_source, verified_at, verified_via,
          organization_id, signals, ip_hash, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16)
       RETURNING *`,
      [String(input.companyName).slice(0, 200), String(input.companyWebsite).slice(0, 500), decision.domain,
       input.requesterName ? String(input.requesterName).slice(0, 160) : null,
       input.requesterEmail, decision.requesterEmail, decision.path, decision.nextStatus,
       decision.officialContact ? decision.officialContact.email : null,
       decision.officialContact ? decision.officialContact.source : null,
       decision.verifiedVia ? new Date() : null, decision.verifiedVia || null,
       decision.organization ? decision.organization.id : null,
       JSON.stringify(decision.signals), tokens.hashIp(input.ip),
       (input.userAgent || '').slice(0, 256) || null]);
    const request = rows[0];

    let confirmation = null;
    if (decision.path === 'b_official_contact') {
      // Hashed, expiring, single-use — the same discipline as every other token in this program.
      const raw = tokens.mintToken();
      const ttl = Number(await configService.get(null, 'event_partners.token_ttl_days')) || 30;
      const t = (await client.query(
        `INSERT INTO event_partner_request_tokens
           (request_id, token_hash, recipient_email_normalized, purpose, expires_at)
         VALUES ($1,$2,$3,'verify_contact',$4) RETURNING id, expires_at`,
        [request.id, tokens.hashToken(raw), normalizeEmail(decision.officialContact.email),
         tokens.expiresInDays(Math.min(ttl, 14))])).rows[0];
      // Returned to the caller ONCE. Phase 2A does not send it.
      confirmation = { token: raw, tokenId: t.id, expiresAt: t.expires_at,
        recipient: decision.officialContact.email, delivery: 'not_sent_phase_2a' };
    }

    if (decision.nextStatus === 'needs_admin') {
      await escalations.open({
        requestId: request.id, reasonCode: decision.path === 'e_blocked' ? 'self_service_conflict' : 'self_service_review',
        severity: decision.path === 'e_blocked' ? 'high' : 'normal',
        summary: `${input.companyName} — ${decision.domain} — ${decision.path}`,
      }, client);
    }

    await auditService.logEvent(client, {
      eventType: 'event_partner.self_service_request', entityType: 'event_partner_request', entityId: request.id,
      actorId: null,
      metadata: { trust_path: decision.path, status: decision.nextStatus, domain: decision.domain,
        organization_id: request.organization_id, risks: (decision.signals.risks || []).map((r) => r.code) },
    });

    return { request, decision, confirmation };
  });
}

/**
 * confirmOfficialContact(raw) — Path B completion. Somebody at the company's own published address
 * opened the link. Atomic single-use consume. Marks the request verified; still does NOT authorize.
 */
async function confirmOfficialContact(raw, ctx) {
  ctx = ctx || {};
  if (!tokens.isWellFormed(raw)) throw err(400, 'INVALID_TOKEN', 'This confirmation link is not valid.');
  const hash = tokens.hashToken(raw);
  return withTransaction(async (client) => {
    const claimed = (await client.query(
      `UPDATE event_partner_request_tokens
          SET used_at = now(), used_ip_hash = $2
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
        RETURNING *`, [hash, tokens.hashIp(ctx.ip)])).rows[0];
    if (!claimed) {
      const probe = (await client.query(
        'SELECT used_at, expires_at FROM event_partner_request_tokens WHERE token_hash = $1', [hash])).rows[0];
      if (!probe) throw err(404, 'INVALID_TOKEN', 'This confirmation link is not valid.');
      if (probe.used_at) throw err(409, 'ALREADY_USED', 'This confirmation link has already been used.');
      throw err(410, 'EXPIRED', 'This confirmation link has expired.');
    }
    const { rows } = await client.query(
      `UPDATE event_partner_requests
          SET status = 'verified', verified_at = now(), verified_via = 'official_contact_link', updated_at = now()
        WHERE id = $1 RETURNING *`, [claimed.request_id]);
    const request = rows[0];
    await auditService.logEvent(client, {
      eventType: 'event_partner.request_verified', entityType: 'event_partner_request', entityId: request.id,
      actorId: null,
      metadata: { via: 'official_contact_link', token_id: claimed.id, domain: request.requested_domain },
    });
    return request;
  });
}

/** Admin approval for Path D / Path E. The only way those requests proceed. */
async function adminReview(requestId, input) {
  input = input || {};
  if (!input.actorId) throw err(401, 'ACTOR_REQUIRED', 'An acting administrator is required.');
  const approve = input.approve === true;
  if (!approve && !String(input.reason || '').trim()) {
    throw err(400, 'REASON_REQUIRED', 'Say why the request is refused.');
  }
  return withTransaction(async (client) => {
    const r = (await client.query('SELECT * FROM event_partner_requests WHERE id = $1 FOR UPDATE', [requestId])).rows[0];
    if (!r) throw err(404, 'NOT_FOUND', 'Request not found.');
    if (['authorized', 'rejected', 'withdrawn'].indexOf(r.status) !== -1) {
      throw err(409, 'ALREADY_RESOLVED', `This request is already ${r.status}.`);
    }
    const { rows } = await client.query(
      `UPDATE event_partner_requests
          SET status = $2, verified_at = CASE WHEN $3 THEN now() ELSE verified_at END,
              verified_via = CASE WHEN $3 THEN 'admin_approval' ELSE verified_via END,
              admin_notes = $4, rejected_reason = $5, reviewed_by = $6, reviewed_at = now(), updated_at = now()
        WHERE id = $1 RETURNING *`,
      [requestId, approve ? 'verified' : 'rejected', approve,
       input.notes || null, approve ? null : String(input.reason).slice(0, 500), input.actorId]);
    await auditService.logEvent(client, {
      eventType: approve ? 'event_partner.request_approved' : 'event_partner.request_rejected',
      entityType: 'event_partner_request', entityId: requestId, actorId: input.actorId,
      metadata: { trust_path: r.trust_path, domain: r.requested_domain },
    });
    return rows[0];
  });
}

async function listRequests(opts, client) {
  opts = opts || {};
  const params = []; const where = [];
  if (opts.status) { params.push(opts.status); where.push(`r.status = $${params.length}`); }
  if (opts.trustPath) { params.push(opts.trustPath); where.push(`r.trust_path = $${params.length}`); }
  params.push(Math.min(Math.max(parseInt(opts.limit, 10) || 50, 1), 200));
  const { rows } = await q(client).query(
    `SELECT r.*, o.name AS matched_org_name, o.slug AS matched_org_slug, o.lifecycle_state AS matched_org_lifecycle
       FROM event_partner_requests r
       LEFT JOIN organizations o ON o.id = r.organization_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY r.created_at DESC LIMIT $${params.length}`, params);
  return rows;
}

module.exports = {
  PATHS, evaluate, submit, confirmOfficialContact, adminReview, listRequests,
  // exported for tests
  domainMatches, emailDomain, findOfficialContact, gatherRiskSignals, matchOrganization,
};
