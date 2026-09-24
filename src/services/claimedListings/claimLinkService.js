'use strict';

/**
 * claimLinkService — the token-first claim experience (handoff section 4).
 *
 *   GET  /claim/:token          preview. NEVER consumes the token (mail scanners pre-open links); a server
 *                               GET is recorded as `link_fetch`, never as a click.
 *   beacon                      `page_view` only after DOM ready AND a human interaction.
 *   continue                    `claim_started` ("This is my company, continue"). Still consumes nothing.
 *   complete                    name + password. The email comes from the token binding, NEVER from input.
 *                               Redeeming the single-use link delivered only to that inbox IS the email
 *                               verification (recorded in the audit log as claim_token_link). An existing
 *                               account must sign in first. organizationLifecycleService.claim() then runs
 *                               the UNCHANGED proof ladder: verifyClaimProof consumes the token atomically.
 *   exits                       not_my_company · business_closed · wrong_contact · remove_listing. Each stops
 *                               the sequence and suppresses the address; removal and wrong-contact create
 *                               staff tasks. No confirmation email is sent.
 *
 * Mailbox control is not business ownership on its own: it only unlocks what the existing ladder allows
 * (a token bound to the address PUBLISHED on the listing). A listing already claimed by someone else is a
 * dispute for a Super Admin, never an automatic transfer.
 */

const bcrypt = require('bcrypt');
const db = require('../../db');
const { withTransaction } = require('../../utils/withTransaction');
const auditService = require('../auditService');
const tokens = require('../eventPartners/tokens');
const { normalizeEmail } = require('../../lib/emailNormalize');
const lifecycle = require('../organizationLifecycleService');
const suppression = require('./suppressionService');
const events = require('./claimEvents');
const tasks = require('./taskService');

const EXITS = {
  not_my_company: { reason: 'not_my_company', event: 'exit_not_my_company', task: 'wrong_contact_research', summary: 'Recipient says this is not their company' },
  business_closed: { reason: 'business_closed', event: 'exit_business_closed', task: 'remove_listing', summary: 'Recipient says the business has closed' },
  wrong_contact: { reason: 'wrong_contact', event: 'exit_wrong_contact', task: 'wrong_contact_research', summary: 'Recipient is not the right contact' },
  remove_listing: { reason: 'remove_listing', event: 'exit_remove_listing', task: 'remove_listing', summary: 'Owner asked for the listing to be removed' },
};

function err(status, code, message) { const e = new Error(message); e.status = status; e.code = code; e.expose = true; return e; }

/** b•••••@gmail.com — the recipient sees which address, nobody else learns it. */
function maskEmail(email) {
  const n = normalizeEmail(email || '');
  if (!n) return null;
  const [local, domain] = n.split('@');
  return local.charAt(0) + '•••••' + '@' + domain;
}

async function ttlDays(runner = db) {
  const r = (await runner.query(`SELECT value FROM platform_config WHERE key = 'claimed_listings.token_ttl_days'`).catch(() => ({ rows: [] }))).rows[0];
  return Number(r && r.value) || 14;
}

/**
 * Issue a claim link bound to the listing's published address. Invalidates any previous unused link
 * (one live link per listing). Returns the RAW token once. `channel`: outreach | self_request | resend | admin.
 */
async function issueToken(organizationId, { channel = 'outreach', invitedEmail = null, actorId = null, reason = null } = {}, runner = db) {
  const org = (await runner.query(`SELECT id, name, contact_email FROM organizations WHERE id = $1`, [organizationId])).rows[0];
  if (!org) throw err(404, 'ORG_NOT_FOUND', 'Listing not found.');
  const owned = (await runner.query(
    `SELECT 1 FROM organization_members WHERE organization_id = $1 AND role = 'owner' AND status = 'active' LIMIT 1`, [organizationId])).rows[0];
  if (owned) throw err(409, 'ALREADY_CLAIMED', 'This listing has already been claimed.');
  const bound = normalizeEmail(invitedEmail || org.contact_email || '');
  if (!bound) throw err(400, 'NO_LISTING_ADDRESS', 'This listing has no email address to send a claim link to.');
  // The binding is ALWAYS the address published on the listing (never an address a requester typed).
  if (normalizeEmail(org.contact_email || '') !== bound && channel !== 'admin') throw err(400, 'ADDRESS_MISMATCH', 'Claim links go only to the address on the listing.');
  await runner.query(`UPDATE organization_claim_tokens SET used_at = now() WHERE organization_id = $1 AND used_at IS NULL`, [organizationId]);
  const raw = tokens.mintToken();
  const row = (await runner.query(
    `INSERT INTO organization_claim_tokens (organization_id, token_hash, invited_email_normalized, expires_at, issued_by, issue_reason, issue_channel)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, expires_at`,
    [organizationId, tokens.hashToken(raw), bound, tokens.expiresInDays(await ttlDays(runner)), actorId, reason, channel])).rows[0];
  return { token: raw, tokenId: row.id, expiresAt: row.expires_at, organizationId, invitedEmail: bound };
}

/**
 * Look a raw token up WITHOUT consuming or modifying it. Returns { state, token, org }.
 * state: valid | expired | used | claimed | invalid.
 */
async function lookup(rawToken, runner = db) {
  if (!tokens.isWellFormed(rawToken)) return { state: 'invalid' };
  const t = (await runner.query(`SELECT * FROM organization_claim_tokens WHERE token_hash = $1`, [tokens.hashToken(rawToken)])).rows[0];
  if (!t) return { state: 'invalid' };
  const org = (await runner.query(
    `SELECT o.id, o.name, o.city, o.state, o.contact_phone, o.website_url, o.description, o.contact_email, o.logo_url,
            o.bd_metadata, o.lifecycle_state,
            EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id = o.id AND m.role = 'owner' AND m.status = 'active') AS has_owner
       FROM organizations o WHERE o.id = $1`, [t.organization_id])).rows[0];
  if (!org) return { state: 'invalid' };
  if (org.has_owner) return { state: 'claimed', token: t, org };
  if (t.used_at) return { state: 'used', token: t, org };
  if (new Date(t.expires_at).getTime() <= Date.now()) return { state: 'expired', token: t, org };
  return { state: 'valid', token: t, org };
}

/** The public preview model for the landing page. Contact PII is limited to what the listing already shows. */
function preview(org, token) {
  return {
    organization_id: org.id, name: org.name, city: org.city || null, state: org.state || null,
    phone: org.contact_phone || null, website: org.website_url || null, description: org.description || null,
    masked_email: maskEmail(token ? token.invited_email_normalized : org.contact_email),
  };
}

async function sequenceForToken(tokenId, runner = db) {
  return (await runner.query(
    `SELECT m.id AS message_id, m.sequence_id, m.company_id FROM listing_outreach_messages m WHERE m.token_id = $1 ORDER BY m.created_at DESC LIMIT 1`,
    [tokenId]).catch(() => ({ rows: [] }))).rows[0] || {};
}

/** Server GET of /claim/:token. Recorded as link_fetch (automated or unknown), never a click. */
async function recordLinkFetch(look, { userAgent = '', ip = '' } = {}, runner = db) {
  if (!look || !look.token) return null;
  const s = await sequenceForToken(look.token.id, runner);
  const cls = events.uaClass(userAgent);
  return events.record('link_fetch', {
    organizationId: look.org.id, companyId: s.company_id, sequenceId: s.sequence_id, messageId: s.message_id,
    tokenId: look.token.id, isAutomated: cls !== 'browser', ipHash: tokens.hashIp(ip),
    email: look.token.invited_email_normalized, meta: { ua_class: cls, state: look.state },
  }, runner);
}

/** Human beacon: only after DOM ready + interaction. Deduped per token + visitor. */
async function recordPageView(rawToken, { visitorId = null, interacted = false, ip = '', search = '', userAgent = '' } = {}, runner = db) {
  if (!interacted) return { recorded: false, reason: 'no interaction' };
  const look = await lookup(rawToken, runner);
  if (!look.token) return { recorded: false, reason: look.state };
  const s = await sequenceForToken(look.token.id, runner);
  await events.record('page_view', {
    organizationId: look.org.id, companyId: s.company_id, sequenceId: s.sequence_id, messageId: s.message_id, tokenId: look.token.id,
    visitorId, ipHash: tokens.hashIp(ip), email: look.token.invited_email_normalized,
    idempotencyKey: 'pv:' + look.token.id + ':' + (visitorId || tokens.hashIp(ip) || 'anon'),
  }, runner);
  // Session attribution (supporting): the campaign parameters only. The token lives in the PATH and is
  // never stored, so the landing URL is recorded as /claim plus the query string.
  if (visitorId && /utm_/.test(String(search || ''))) {
    const q = String(search).replace(/^\?/, '').slice(0, 600);
    await require('../attributionService').recordTouch({ visitorId, landingUrl: 'https://bid.advantage.bid/claim?' + q,
      userAgentClass: require('../attributionService').classifyUserAgent(userAgent) }, runner).catch(() => {});
  }
  return { recorded: true };
}

/** "This is my company, continue" — claim_started. Nothing is consumed. */
async function startClaim(rawToken, { visitorId = null, ip = '' } = {}, runner = db) {
  const look = await lookup(rawToken, runner);
  if (look.state !== 'valid') return { ok: false, state: look.state };
  const s = await sequenceForToken(look.token.id, runner);
  await events.record('claim_started', {
    organizationId: look.org.id, companyId: s.company_id, sequenceId: s.sequence_id, messageId: s.message_id, tokenId: look.token.id,
    visitorId, ipHash: tokens.hashIp(ip), email: look.token.invited_email_normalized,
    idempotencyKey: 'cs:' + look.token.id + ':' + (visitorId || tokens.hashIp(ip) || 'anon'),
  }, runner);
  const existing = (await runner.query(`SELECT id FROM users WHERE lower(email) = $1`, [look.token.invited_email_normalized])).rows[0];
  return { ok: true, account_exists: !!existing, masked_email: maskEmail(look.token.invited_email_normalized) };
}

/**
 * Complete the claim. `signedInUser` = { id } from a valid session, or null.
 *   - no account for the bound address → create it (email verified by the token), then claim;
 *   - an account exists and the caller is signed in AS that account → claim;
 *   - otherwise → 409 SIGN_IN_REQUIRED (the page switches to a sign-in form prefilled with the address).
 * Returns { organization, userId, created }.
 */
async function complete(rawToken, { fullName = '', password = '', signedInUser = null, ip = '', visitorId = null } = {}) {
  const look = await lookup(rawToken);
  if (look.state !== 'valid') throw err(look.state === 'claimed' ? 409 : 410, 'CLAIM_LINK_' + look.state.toUpperCase(), linkStateMessage(look.state));
  const bound = look.token.invited_email_normalized;
  let userId = null;
  let created = false;
  const existing = (await db.query(`SELECT id, email, email_verified FROM users WHERE lower(email) = $1`, [bound])).rows[0];
  if (existing) {
    if (!signedInUser || signedInUser.id !== existing.id) {
      throw Object.assign(err(409, 'SIGN_IN_REQUIRED', 'An account already uses this address. Sign in to finish claiming.'), { masked_email: maskEmail(bound) });
    }
    userId = existing.id;
    if (existing.email_verified !== true) {
      // The signed-in owner of the bound address has just proven control of it by redeeming the link.
      await db.query(`UPDATE users SET email_verified = true, email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1`, [userId]);
      await auditService.logEvent(db, { eventType: 'user.email_verified', entityType: 'user', entityId: userId, actorId: userId,
        metadata: { reason: 'claim_token_link', token_id: look.token.id } }).catch(() => {});
    }
  } else {
    const name = String(fullName || '').trim().slice(0, 120);
    if (name.length < 2) throw err(400, 'NAME_REQUIRED', 'Please enter your name.');
    if (String(password || '').length < 8) throw err(400, 'PASSWORD_TOO_SHORT', 'Choose a password of at least 8 characters.');
    const hash = await bcrypt.hash(String(password), 10);
    try {
      const u = (await db.query(
        `INSERT INTO users (email, password_hash, role, full_name, email_verified, email_verified_at, auth_source)
         VALUES ($1,$2,'buyer',$3,true,now(),'claim_link') RETURNING id`, [bound, hash, name])).rows[0];
      userId = u.id; created = true;
    } catch (e) {
      if (e.code === '23505') throw Object.assign(err(409, 'SIGN_IN_REQUIRED', 'An account already uses this address. Sign in to finish claiming.'), { masked_email: maskEmail(bound) });
      throw e;
    }
    await auditService.logEvent(db, { eventType: 'user.email_verified', entityType: 'user', entityId: userId, actorId: userId,
      metadata: { reason: 'claim_token_link', token_id: look.token.id, organization_id: look.org.id } }).catch(() => {});
  }

  // The UNCHANGED proof ladder: verifyClaimProof re-checks binding + verification and consumes the token
  // atomically in the same transaction as the ownership grant.
  const org = await lifecycle.claim(userId, look.org.id, { claimToken: rawToken, ip });
  await afterClaim({ organizationId: org.id, userId, tokenId: look.token.id, proofMethod: 'claim_token', visitorId, ip });
  return { organization: org, userId, created };
}

function linkStateMessage(state) {
  return {
    expired: 'This claim link has expired.', used: 'This claim link has already been used.',
    claimed: 'This listing has already been claimed.', invalid: 'This claim link is not valid.',
  }[state] || 'This claim link cannot be used.';
}

/**
 * Everything that follows a verified claim, from any path (token, company-domain email, admin override):
 * funnel event, hard attribution record, sequence stop + lock release, activation track start.
 * Best-effort: never undoes the claim.
 */
async function afterClaim({ organizationId, userId, tokenId = null, proofMethod, visitorId = null, ip = '' }) {
  // Each step is independent: one failing never prevents the others (above all, never the claim email).
  const step = async (name, fn) => { try { await fn(); } catch (e) { console.error('[claimed-listing] afterClaim ' + name + ' failed:', e.message); } };
  const s = tokenId ? await sequenceForToken(tokenId).catch(() => ({})) : {};
  await step('stop_outreach', async () => {
    await db.query(
      `UPDATE listing_outreach_sequences SET state = 'stopped', stop_reason = 'claim_verified', next_send_at = NULL, updated_at = now()
        WHERE organization_id = $1 AND state IN ('queued','active','paused','dormant')`, [organizationId]);
    await db.query(`DELETE FROM company_contact_locks WHERE holder_type = 'system' AND sequence_id IN
      (SELECT id FROM listing_outreach_sequences WHERE organization_id = $1)`, [organizationId]);
  });
  await step('funnel', () => events.record('claim_verified', { organizationId, companyId: s.company_id, sequenceId: s.sequence_id, messageId: s.message_id,
    tokenId, userId, visitorId, ipHash: tokens.hashIp(ip), meta: { proof_method: proofMethod }, idempotencyKey: 'cv:' + organizationId }));
  await step('attribution', () => require('./acquisitionService').recordClaimAcquisition({ organizationId, tokenId, proofMethod }));
  await step('conversion_ledger', async () => {
    const conv = require('../conversionService');
    if (visitorId) await require('../attributionService').stitch({ visitorId, userId, source: 'claim' }).catch(() => {});
    await conv.record('claimed_listing_claimed', { userId, visitorId, subjectType: 'organization', subjectId: organizationId, idempotencyKey: 'clc:' + organizationId });
  });
  await step('crm_stage', () => db.query(`UPDATE organizations SET crm_stage = 'claimed' WHERE id = $1 AND (crm_stage IS NULL OR crm_stage IN ('prospect','contacted','interested','demo_scheduled'))`, [organizationId]));
  let tracked = false;
  await step('activation', async () => { await require('./activationService').startTrack({ organizationId, proofMethod }); tracked = true; });
  if (!tracked) {
    // The activation track could not start: still send the one-time claim email the platform has always sent.
    await step('welcome_fallback', async () => {
      const row = (await db.query(`SELECT o.name, u.email FROM organizations o JOIN users u ON u.id = $2 WHERE o.id = $1`, [organizationId, userId])).rows[0];
      if (row && row.email) {
        const m = require('../businessListingEmails').buildWelcomeEmail({ companyName: row.name, claimed: true });
        await require('../emailService').sendEmail({ to: row.email, ...m });
      }
    });
  }
}

/** One of the four exit options. Idempotent per token + action. */
async function exit(rawToken, action, { ip = '' } = {}) {
  const x = EXITS[action];
  if (!x) throw err(400, 'UNKNOWN_OPTION', 'Unknown option.');
  const look = await lookup(rawToken);
  if (!look.token || look.state === 'claimed') throw err(410, 'CLAIM_LINK_' + String(look.state).toUpperCase(), linkStateMessage(look.state));
  const s = await sequenceForToken(look.token.id);
  await suppression.suppress({ email: look.token.invited_email_normalized, reason: x.reason, source: 'claim_page',
    organizationId: look.org.id, companyId: s.company_id || null });
  await events.record(x.event, { organizationId: look.org.id, companyId: s.company_id, sequenceId: s.sequence_id, tokenId: look.token.id,
    ipHash: tokens.hashIp(ip), email: look.token.invited_email_normalized, idempotencyKey: 'exit:' + action + ':' + look.token.id });
  if (action === 'remove_listing' || action === 'business_closed') {
    // Soft, reversible: the listing leaves outreach now; staff unpublish it within two business days.
    await db.query(
      `UPDATE organizations SET profile_data = COALESCE(profile_data,'{}'::jsonb) || jsonb_build_object('removal_requested_at', now()::text, 'removal_reason', $2::text)
        WHERE id = $1`, [look.org.id, action]);
  }
  await tasks.open({ type: x.task, organizationId: look.org.id, companyId: s.company_id || null, summary: x.summary + ': ' + look.org.name,
    payload: { action, token_id: look.token.id, via: 'claim_page' }, dedupeKey: 'exit:' + action + ':' + look.org.id });
  return { ok: true, action };
}

// ── self-service claim request (the directory "Claim this listing" button) ────────────────────

/** Public, masked context for /claim-listing.html?org=. No email is ever returned in full. */
async function claimContext(organizationId) {
  const o = (await db.query(
    `SELECT o.id, o.name, o.city, o.state, o.contact_email, o.bd_sync_status, o.profile_data, o.lifecycle_state,
            EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id = o.id AND m.role = 'owner' AND m.status = 'active') AS has_owner
       FROM organizations o WHERE o.id = $1`, [organizationId]).catch(() => ({ rows: [] }))).rows[0];
  if (!o) return null;
  const enabled = (await db.query(`SELECT value FROM platform_config WHERE key = 'claimed_listings.self_request_enabled'`)).rows[0];
  const supp = await suppression.check({ email: o.contact_email, organizationId: o.id });
  const removed = o.bd_sync_status === 'removed' || !!(o.profile_data && o.profile_data.removal_requested_at);
  const claimable = !o.has_owner && ['prospect', 'directory_listing', 'inactive'].includes(o.lifecycle_state) && !removed;
  return {
    organization_id: o.id, name: o.name, city: o.city, state: o.state,
    claimed: !!o.has_owner, claimable,
    masked_email: claimable ? maskEmail(o.contact_email) : null,
    self_request_available: claimable && !!(enabled && enabled.value === true) && !!normalizeEmail(o.contact_email || '') && !supp.suppressed,
    help_available: claimable,
    dispute_available: !!o.has_owner,
  };
}

/**
 * "Send my claim link". Rate limits: 1 per listing per 24h, 3 per listing per 7 days, 10 per IP per day.
 * Refused when claimed, suppressed or out of scope. Sends only when the Owner switch is ON and an
 * APPROVED CL_SELF_REQUEST template exists (fail closed). The response never reveals the address.
 */
async function selfRequest(organizationId, { ip = '' } = {}) {
  const ctx = await claimContext(organizationId);
  if (!ctx) throw err(404, 'NOT_FOUND', 'Listing not found.');
  if (!ctx.claimable) throw err(409, 'NOT_CLAIMABLE', ctx.claimed ? 'This listing has already been claimed.' : 'This listing cannot be claimed online.');
  if (!ctx.self_request_available) throw err(503, 'SELF_REQUEST_UNAVAILABLE', 'Claim links by email are not available for this listing yet. Ask us for help instead.');
  const ipHash = tokens.hashIp(ip);
  if (await events.countSince('self_request', { organizationId, hours: 24 }) >= 1) throw err(429, 'RATE_LIMITED', 'A claim link was sent recently. Please check that inbox, or try again tomorrow.');
  if (await events.countSince('self_request', { organizationId, hours: 24 * 7 }) >= 3) throw err(429, 'RATE_LIMITED', 'Too many claim links were requested this week. Ask us for help instead.');
  if (ipHash && await events.countSince('self_request', { ipHash, hours: 24 }) >= 10) throw err(429, 'RATE_LIMITED', 'Too many requests. Please try again tomorrow.');
  const sender = require('./outreachSender');
  const result = await sender.sendSelfRequest({ organizationId, ipHash });
  await events.record('self_request', { organizationId, ipHash, meta: { sent: !!result.sent, reason: result.reason || null } });
  if (!result.sent) throw err(503, 'SELF_REQUEST_UNAVAILABLE', 'We could not send a claim link right now. Ask us for help instead.');
  return { ok: true, masked_email: ctx.masked_email };
}

/** "I can't access that email". Staff verify by calling the phone ON THE LISTING, never the one supplied. */
async function helpRequest(organizationId, { name, role = null, phone = null, message = null, email = null }, { ip = '' } = {}) {
  const ctx = await claimContext(organizationId);
  if (!ctx) throw err(404, 'NOT_FOUND', 'Listing not found.');
  const n = String(name || '').trim().slice(0, 120);
  if (n.length < 2) throw err(400, 'NAME_REQUIRED', 'Please tell us your name.');
  const ipHash = tokens.hashIp(ip);
  if (ipHash && await events.countSince('help_request', { ipHash, hours: 24 }) >= 5) throw err(429, 'RATE_LIMITED', 'Too many requests. Please try again tomorrow.');
  const org = (await db.query(`SELECT contact_phone FROM organizations WHERE id = $1`, [organizationId])).rows[0] || {};
  const type = ctx.claimed ? 'dispute' : 'claim_help_request';
  await tasks.open({ type, organizationId, summary: (ctx.claimed ? 'Ownership dispute: ' : 'Claim help: ') + ctx.name + ' (' + n + ')',
    priority: ctx.claimed ? 'high' : 'normal',
    payload: { requester_name: n, requester_role: role ? String(role).slice(0, 80) : null,
      requester_phone_supplied: phone ? String(phone).slice(0, 40) : null, requester_email_supplied: email ? String(email).slice(0, 200) : null,
      message: message ? String(message).slice(0, 2000) : null,
      verify_by_calling_listing_phone: org.contact_phone || null,
      rule: ctx.claimed ? 'Ownership moves only by Super Admin after review.'
        : 'Verify by calling the phone number ON THE LISTING (never the number supplied here), then assign with admin override.' } });
  await events.record(ctx.claimed ? 'dispute' : 'help_request', { organizationId, ipHash });
  return { ok: true };
}

/** A tiny public lookup so the directory button can point at the right Railway listing. 404 when claimed/hidden. */
async function byBdListingId(bdListingId) {
  const o = (await db.query(
    `SELECT o.id, o.bd_sync_status, o.profile_data,
            EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id = o.id AND m.role = 'owner' AND m.status = 'active') AS has_owner
       FROM organizations o WHERE o.bd_listing_id = $1 LIMIT 1`, [String(bdListingId)])).rows[0];
  if (!o || o.has_owner || o.bd_sync_status === 'removed' || (o.profile_data && o.profile_data.removal_requested_at)) return null;
  return { orgId: o.id };
}

module.exports = {
  EXITS, maskEmail, issueToken, lookup, preview, recordLinkFetch, recordPageView, startClaim, complete, afterClaim, exit,
  claimContext, selfRequest, helpRequest, byBdListingId, linkStateMessage,
};
