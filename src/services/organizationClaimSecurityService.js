'use strict';

/**
 * organizationClaimSecurityService — proves that the person claiming a directory listing is entitled
 * to it.
 *
 * The weakness this closes: POST /api/org/claim/:orgId previously required nothing but a signed-in
 * account. Any authenticated user who found a listing through /api/org/claim/search could become the
 * owner of any unclaimed organization — first authenticated user wins. With 336 imported directory
 * listings, and with the Event Partner programme about to populate some of them with real companies'
 * events, that is not acceptable.
 *
 * Proof ladder, strongest first. A claim needs exactly one to hold:
 *
 *   1. claim_token            — an administrator issued a single-use, expiring link bound to ONE
 *                               recipient email, hashed at rest. Redemption additionally requires that
 *                               the signed-in user's VERIFIED email equals that binding, so a
 *                               forwarded or leaked link is not enough on its own.
 *   2. verified_email_domain  — the user's VERIFIED email is on the same registrable domain as the
 *                               organization's own website or its listed contact address. Controlling
 *                               name@company.com is meaningful evidence of working at that company.
 *
 * Everything else is denied with CLAIM_VERIFICATION_REQUIRED. Nothing is inferred from simply having
 * found the listing.
 *
 * Two policy tighteners:
 *   - An EVENT PARTNER organization (one we invited into the programme) always requires a token.
 *     A company that authorized free promotion must never be exposed to weaker claiming.
 *   - platform_config organizations.claim_proof_policy = 'token_only' requires a token everywhere.
 *
 * Every attempt, granted or denied, is written to organization_claim_attempts.
 */

const db = require('../db');
const { withTransaction } = require('../utils/withTransaction');
const configService = require('./configService');
const { normalizeEmail } = require('../lib/emailNormalize');
const tokens = require('./eventPartners/tokens');
const authorization = require('./eventPartners/authorizationService');

function err(status, code, message) {
  const e = new Error(message); e.status = status; e.code = code; e.expose = true; return e;
}

const POLICY_TOKEN_ONLY = 'token_only';
const POLICY_TOKEN_OR_DOMAIN = 'token_or_verified_domain';

/** Registrable host of an email address, or null. */
function emailDomain(email) {
  const n = normalizeEmail(email);
  if (!n) return null;
  const host = n.split('@')[1] || '';
  return host.replace(/^www\./, '') || null;
}

/** Registrable host of a website URL, or null. Shares the Event Partner normalizer. */
function siteDomain(url) {
  return authorization.normalizeDomain(url);
}

/**
 * Free public email hosts. A verified gmail.com address proves nothing about a company, so the
 * domain rung of the ladder must never fire for one — otherwise anyone with a Gmail account could
 * claim any listing whose contact address is also on Gmail.
 */
const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'hotmail.com', 'outlook.com', 'live.com',
  'msn.com', 'aol.com', 'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'gmx.com',
  'mail.com', 'zoho.com', 'yandex.com', 'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net',
  'bellsouth.net', 'cox.net', 'earthlink.net', 'charter.net', 'roadrunner.com', 'juno.com',
]);

/** Record an attempt. Best-effort inside the caller's transaction; never the reason a claim fails. */
async function recordAttempt(client, row) {
  try {
    await client.query(
      `INSERT INTO organization_claim_attempts
         (organization_id, user_id, outcome, proof_method, denial_code, claim_token_id, ip_hash, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [row.organizationId, row.userId || null, row.outcome, row.proofMethod, row.denialCode || null,
       row.claimTokenId || null, row.ipHash || null, JSON.stringify(row.detail || {})]);
  } catch (e) { /* evidence is best-effort; the security decision itself already happened */ }
}

/**
 * Issue a claim link for an organization, bound to one recipient. Returns the RAW token exactly once —
 * it is never stored and cannot be recovered. Phase 1 has no sender: the administrator receives the
 * link and nothing is emailed.
 */
async function issueClaimToken(organizationId, input) {
  input = input || {};
  if (!input.actorId) throw err(401, 'ACTOR_REQUIRED', 'An acting administrator is required.');
  const invited = normalizeEmail(input.invitedEmail);
  if (!invited) throw err(400, 'INVALID_EMAIL', 'A valid recipient email is required.');

  return withTransaction(async (client) => {
    const org = (await client.query(
      'SELECT id, name, lifecycle_state FROM organizations WHERE id = $1', [organizationId])).rows[0];
    if (!org) throw err(404, 'ORG_NOT_FOUND', 'Organization not found.');
    const owned = (await client.query(
      "SELECT 1 FROM organization_members WHERE organization_id = $1 AND role = 'owner' AND status = 'active' LIMIT 1",
      [organizationId])).rows[0];
    if (owned) throw err(409, 'ALREADY_CLAIMED', 'This organization has already been claimed.');

    // One live claim link at a time per organization.
    await client.query(
      'UPDATE organization_claim_tokens SET used_at = now() WHERE organization_id = $1 AND used_at IS NULL',
      [organizationId]);

    const ttlDays = input.ttlDays != null ? input.ttlDays
      : (await configService.get(null, 'event_partners.claim_token_ttl_days')) || 14;
    const raw = tokens.mintToken();
    const { rows } = await client.query(
      `INSERT INTO organization_claim_tokens
         (organization_id, token_hash, invited_email_normalized, expires_at, issued_by, issue_reason)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, expires_at`,
      [organizationId, tokens.hashToken(raw), invited, tokens.expiresInDays(ttlDays),
       input.actorId, input.reason || null]);
    return { token: raw, tokenId: rows[0].id, expiresAt: rows[0].expires_at, organizationId, invitedEmail: invited };
  });
}

/**
 * Decide whether `user` may claim `organizationId`, inside the caller's transaction.
 *
 * Returns { ok: true, proofMethod, claimTokenId } or throws a structured error. When a token is
 * accepted it is consumed here, atomically, in the same transaction that performs the claim — so a
 * token can never be spent by a claim that subsequently rolls back, and never spent twice.
 */
async function verifyClaimProof(client, user, organizationId, input) {
  input = input || {};
  const ipHash = tokens.hashIp(input.ip);
  const policy = (await configService.get(null, 'organizations.claim_proof_policy')) || POLICY_TOKEN_OR_DOMAIN;
  const isPartner = await authorization.isEventPartnerOrganization(organizationId, client);
  const tokenRequired = policy === POLICY_TOKEN_ONLY || isPartner;

  const deny = async (code, message, detail) => {
    await recordAttempt(client, {
      organizationId, userId: user && user.id, outcome: 'denied', proofMethod: 'none',
      denialCode: code, ipHash, detail: Object.assign({ token_required: tokenRequired, is_event_partner: isPartner }, detail || {}),
    });
    throw err(403, code, message);
  };

  // ── Rung 1: an administrator-issued, recipient-bound, single-use claim token ──────────────────
  if (input.claimToken) {
    if (!tokens.isWellFormed(input.claimToken)) await deny('CLAIM_TOKEN_INVALID', 'This claim link is not valid.');
    const hash = tokens.hashToken(input.claimToken);
    const t = (await client.query(
      'SELECT * FROM organization_claim_tokens WHERE token_hash = $1 FOR UPDATE', [hash])).rows[0];
    // Count the presentation whatever the outcome, so guessing is visible.
    if (t) await client.query('UPDATE organization_claim_tokens SET attempts = attempts + 1 WHERE id = $1', [t.id]);

    if (!t) await deny('CLAIM_TOKEN_INVALID', 'This claim link is not valid.');
    if (t.organization_id !== organizationId) {
      // A token for company A must never claim company B.
      await deny('CLAIM_TOKEN_WRONG_ORG', 'This claim link is for a different company.', { token_id: t.id });
    }
    if (t.used_at) await deny('CLAIM_TOKEN_USED', 'This claim link has already been used.', { token_id: t.id });
    if (new Date(t.expires_at).getTime() <= Date.now()) await deny('CLAIM_TOKEN_EXPIRED', 'This claim link has expired.', { token_id: t.id });

    // Recipient binding: possession of the link is not sufficient. The signed-in account must own the
    // invited address AND have verified it.
    const userEmail = normalizeEmail(user && user.email);
    if (!userEmail || !tokens.safeEqual(userEmail, t.invited_email_normalized)) {
      await deny('CLAIM_TOKEN_WRONG_RECIPIENT', 'This claim link was issued to a different email address.', { token_id: t.id });
    }
    if (user.email_verified !== true) {
      await deny('EMAIL_NOT_VERIFIED', 'Verify your email address before claiming this listing.', { token_id: t.id });
    }

    // Atomic single-use consume: only a row still unused and unexpired can be claimed.
    const consumed = (await client.query(
      `UPDATE organization_claim_tokens
          SET used_at = now(), used_by_user_id = $2, used_ip_hash = $3
        WHERE id = $1 AND used_at IS NULL AND expires_at > now()
        RETURNING id`, [t.id, user.id, ipHash])).rows[0];
    if (!consumed) await deny('CLAIM_TOKEN_USED', 'This claim link has already been used.', { token_id: t.id });

    return { ok: true, proofMethod: 'claim_token', claimTokenId: t.id, ipHash };
  }

  // ── Rung 2: a verified company-domain email ──────────────────────────────────────────────────
  if (tokenRequired) {
    await deny('CLAIM_TOKEN_REQUIRED',
      isPartner
        ? 'This listing is part of the Event Partner programme and can only be claimed with an invitation link.'
        : 'A claim invitation link is required to claim this listing.');
  }

  const org = (await client.query(
    'SELECT id, name, website_url, contact_email FROM organizations WHERE id = $1', [organizationId])).rows[0];
  if (!org) throw err(404, 'ORG_NOT_FOUND', 'Organization not found.');

  if (user.email_verified !== true) {
    await deny('EMAIL_NOT_VERIFIED', 'Verify your email address before claiming a listing.');
  }
  const userDomain = emailDomain(user.email);
  if (!userDomain) await deny('CLAIM_VERIFICATION_REQUIRED', 'We could not verify your connection to this company.');
  if (PUBLIC_EMAIL_DOMAINS.has(userDomain)) {
    // A free mailbox proves nothing about a company, however well it matches.
    await deny('CLAIM_VERIFICATION_REQUIRED',
      'A company email address or an invitation link is required to claim this listing.', { reason: 'public_email_domain' });
  }

  const orgSite = siteDomain(org.website_url);
  const orgContact = emailDomain(org.contact_email);
  const matchesSite = !!(orgSite && (userDomain === orgSite || userDomain.endsWith('.' + orgSite)));
  const matchesContact = !!(orgContact && !PUBLIC_EMAIL_DOMAINS.has(orgContact) && userDomain === orgContact);
  if (!matchesSite && !matchesContact) {
    await deny('CLAIM_VERIFICATION_REQUIRED',
      'We could not verify your connection to this company. Request a claim invitation to continue.',
      { user_domain: userDomain, org_site_domain: orgSite || null });
  }

  return {
    ok: true, proofMethod: 'verified_email_domain', claimTokenId: null, ipHash,
    detail: { user_domain: userDomain, matched: matchesSite ? 'website_url' : 'contact_email' },
  };
}

/** Load the fields the proof check needs. Kept here so callers cannot forget email_verified. */
async function loadClaimant(client, userId) {
  const { rows } = await (client || db).query(
    'SELECT id, email, email_verified, role FROM users WHERE id = $1', [userId]);
  return rows[0] || null;
}

module.exports = {
  POLICY_TOKEN_ONLY, POLICY_TOKEN_OR_DOMAIN, PUBLIC_EMAIL_DOMAINS,
  issueClaimToken, verifyClaimProof, recordAttempt, loadClaimant, emailDomain, siteDomain,
  // Re-exported so callers never reach past this module for the evidence IP hash.
  hashIpForClaim: tokens.hashIp,
};
