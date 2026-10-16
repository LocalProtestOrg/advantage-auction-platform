'use strict';

/**
 * Professional Seller staff accounts (migration 199; owner-approved design docs/projects/seller-staff-permissions-design-2026-10-16.md).
 *
 * Owner (with step-up)   invite(email, role) · revokeInvite · changeRole · suspend · reinstate · remove
 * Owner                  listTeam (members + history)
 * Invitee (signed in)    previewInvite(token) · acceptInvite(token) — the account email must equal the invited email
 * Staff                  myMembership
 *
 * Rules (owner-approved defaults 2026-10-16):
 *   • one company per person (database: one active/suspended membership per account); the owner of any company cannot
 *     be staff; a staff role can never be "owner";
 *   • the company always comes from the OWNER's session (ctx.sellerId) — a member id from the request is only ever
 *     looked up inside that company, so another company's member is "not found";
 *   • invitations are single-use, expire after 7 days, are stored as a hash, and are rate-limited per company;
 *   • access ends immediately on suspension, removal or role change (the membership is read on every request);
 *   • everything is written to the append-only staff history (actor, company, time).
 * Nothing works while SELLER_STAFF_ENABLED is off.
 */
const crypto = require('crypto');
const db = require('../db');
const { withTransaction } = require('../utils/withTransaction');
const { SELLER_ROLES, permissionsForRole } = require('../lib/sellerRbac');
const { sellerStaffEnabled } = require('../lib/launchGuards');

const STAFF_ROLES = ['inventory_manager', 'fulfillment', 'finance'];
const INVITE_DAYS = 7; const INVITES_PER_DAY = 20;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']{2,}$/;

function err(status, code, message) { const e = new Error(message); e.status = status; e.code = code; return e; }
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const base = () => (process.env.APP_BASE_URL || 'https://bid.advantage.bid').replace(/\/+$/, '');

function enabled(env = process.env) { if (!sellerStaffEnabled(env)) throw err(404, 'STAFF_NOT_AVAILABLE', 'Staff accounts are not available yet.'); }
function ownerOnly(ctx) { if (!ctx || ctx.role !== 'owner' || ctx.staff || !ctx.sellerId) throw err(403, 'OWNER_ONLY', 'Only the company owner can manage staff.'); }

async function event(runner, member, action, actorUserId, actorRole, data = {}) {
  await runner.query(
    `INSERT INTO seller_staff_events (member_id, seller_id, action, actor_user_id, actor_role, data) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [member.id, member.seller_id, action, actorUserId || null, actorRole, JSON.stringify(data)]);
}

function memberView(r) {
  return { id: r.id, email: r.invited_email, role: r.role, role_label: (SELLER_ROLES[r.role] || {}).label || r.role,
    status: r.status, name: r.full_name || null, invited_at: r.invited_at, invite_expires_at: r.status === 'invited' ? r.invite_expires_at : null,
    accepted_at: r.accepted_at || null, removed_at: r.removed_at || null };
}

async function companyName(sellerId, runner = db) {
  const r = (await runner.query(`SELECT COALESCE(display_name, metadata->>'display_name', metadata->>'business_name') AS name FROM seller_profiles WHERE id = $1`, [sellerId])).rows[0];
  return (r && r.name) || 'your company';
}

async function expireStale(runner, sellerId) {
  const rows = (await runner.query(
    `UPDATE seller_staff_members SET status = 'expired', invite_token_hash = NULL, updated_at = now()
      WHERE seller_id = $1 AND status = 'invited' AND invite_expires_at <= now() RETURNING id, seller_id`, [sellerId])).rows;
  for (const m of rows) await event(runner, m, 'invite_expired', null, 'system');
}

async function listTeam(ctx) {
  enabled(); ownerOnly(ctx);
  await expireStale(db, ctx.sellerId);
  const members = (await db.query(
    `SELECT m.*, u.full_name FROM seller_staff_members m LEFT JOIN users u ON u.id = m.user_id
      WHERE m.seller_id = $1 ORDER BY m.invited_at DESC LIMIT 500`, [ctx.sellerId])).rows.map(memberView);
  const history = (await db.query(
    `SELECT e.action, e.actor_role, e.data, e.created_at, m.invited_email
       FROM seller_staff_events e JOIN seller_staff_members m ON m.id = e.member_id AND m.seller_id = e.seller_id
      WHERE e.seller_id = $1 ORDER BY e.created_at DESC LIMIT 200`, [ctx.sellerId])).rows
    .map((h) => ({ action: h.action, by: h.actor_role, member_email: h.invited_email, at: h.created_at,
      details: Object.fromEntries(Object.entries(h.data || {}).filter(([k]) => ['role', 'from', 'to', 'method', 'path', 'permission'].includes(k))) }));
  return { roles: STAFF_ROLES.map((r) => ({ role: r, label: SELLER_ROLES[r].label, permissions: [...permissionsForRole(r)] })), members, history };
}

async function invite(ctx, { email, role } = {}, deps = {}) {
  enabled(); ownerOnly(ctx);
  const addr = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(addr) || addr.length > 320) throw err(422, 'EMAIL_INVALID', 'Enter a valid email address.');
  if (!STAFF_ROLES.includes(role)) throw err(422, 'ROLE_INVALID', 'Choose a staff role.');
  const token = crypto.randomBytes(32).toString('base64url');
  const out = await withTransaction(async (client) => {
    await client.query('SELECT id FROM seller_profiles WHERE id = $1 FOR UPDATE', [ctx.sellerId]);   // serialise invites per company
    await expireStale(client, ctx.sellerId);
    const recent = Number((await client.query(`SELECT count(*)::int n FROM seller_staff_members WHERE seller_id = $1 AND invited_at > now() - interval '1 day'`, [ctx.sellerId])).rows[0].n);
    if (recent >= INVITES_PER_DAY) throw err(429, 'RATE_LIMITED', 'Too many invitations today. Please try again tomorrow.');
    const owner = (await client.query(`SELECT lower(email) AS email FROM users WHERE id = $1`, [ctx.userId])).rows[0];
    if (owner && owner.email === addr) throw err(409, 'INVITEE_IS_OWNER', 'You already own this company.');
    const existing = (await client.query('SELECT id, COALESCE(is_active, true) AS active FROM users WHERE lower(email) = $1', [addr])).rows[0];
    if (existing) {
      if ((await client.query('SELECT 1 FROM seller_profiles WHERE user_id = $1', [existing.id])).rowCount) {
        throw err(409, 'INVITEE_IS_OWNER', 'That person already owns a seller company, so they cannot be added as staff.');
      }
      if ((await client.query(`SELECT 1 FROM seller_staff_members WHERE user_id = $1 AND status IN ('active','suspended')`, [existing.id])).rowCount) {
        throw err(409, 'ALREADY_STAFF', 'That person is already staff for a seller company.');
      }
    }
    if ((await client.query(`SELECT 1 FROM seller_staff_members WHERE seller_id = $1 AND invited_email = $2 AND status = 'invited'`, [ctx.sellerId, addr])).rowCount) {
      throw err(409, 'ALREADY_INVITED', 'That email already has an open invitation. Revoke it to send a new one.');
    }
    const m = (await client.query(
      `INSERT INTO seller_staff_members (seller_id, invited_email, role, invite_token_hash, invite_expires_at, invited_by)
       VALUES ($1,$2,$3,$4, now() + interval '${INVITE_DAYS} days', $5) RETURNING *`,
      [ctx.sellerId, addr, role, hashToken(token), ctx.userId])).rows[0];
    await event(client, m, 'invited', ctx.userId, 'owner', { role });
    return m;
  });
  const company = await companyName(ctx.sellerId);
  const link = `${base()}/seller-staff-invite.html?token=${encodeURIComponent(token)}`;
  try {
    const mail = deps.emailService || require('./emailService');
    await mail.sendEmail({ to: addr, subject: `You're invited to help manage ${company} on Advantage.Bid`,
      text: [`${company} invited you to join their Advantage.Bid seller team as ${SELLER_ROLES[role].label}.`, '',
        `Accept the invitation (it expires in ${INVITE_DAYS} days):`, link, '',
        'Sign in or create an account with this email address to accept. If you were not expecting this, you can ignore this email.'].join('\n') });
  } catch (e) { console.error('[seller-staff] invitation email failed:', e.message); }
  return { ...memberView(out), ...(deps.returnToken ? { _token: token } : {}) };
}

// Load a member of THE OWNER'S company (any other company's member id is simply not found).
async function ownMember(client, ctx, memberId) {
  if (!UUID_RE.test(String(memberId || ''))) throw err(404, 'MEMBER_NOT_FOUND', 'Staff member not found.');
  const m = (await client.query('SELECT * FROM seller_staff_members WHERE id = $1 AND seller_id = $2 FOR UPDATE', [memberId, ctx.sellerId])).rows[0];
  if (!m) throw err(404, 'MEMBER_NOT_FOUND', 'Staff member not found.');
  return m;
}

async function revokeInvite(ctx, memberId) {
  enabled(); ownerOnly(ctx);
  return withTransaction(async (client) => {
    const m = await ownMember(client, ctx, memberId);
    if (m.status !== 'invited') throw err(409, 'NOT_AN_INVITATION', 'This is not an open invitation.');
    const u = (await client.query(`UPDATE seller_staff_members SET status = 'revoked', invite_token_hash = NULL, removed_by = $2, removed_at = now(), updated_at = now()
      WHERE id = $1 RETURNING *`, [m.id, ctx.userId])).rows[0];
    await event(client, m, 'invite_revoked', ctx.userId, 'owner');
    return memberView(u);
  });
}

async function changeRole(ctx, memberId, { role } = {}) {
  enabled(); ownerOnly(ctx);
  if (!STAFF_ROLES.includes(role)) throw err(422, 'ROLE_INVALID', 'Choose a staff role.');
  return withTransaction(async (client) => {
    const m = await ownMember(client, ctx, memberId);
    if (!['invited', 'active', 'suspended'].includes(m.status)) throw err(409, 'MEMBER_CLOSED', 'This person is no longer on your team.');
    if (m.role === role) return memberView(m);
    const u = (await client.query('UPDATE seller_staff_members SET role = $2, updated_at = now() WHERE id = $1 RETURNING *', [m.id, role])).rows[0];
    await event(client, m, 'role_changed', ctx.userId, 'owner', { from: m.role, to: role });
    return memberView(u);
  });
}

const STATUS_ACTIONS = {
  suspend: { from: ['active'], to: 'suspended', event: 'suspended' },
  reinstate: { from: ['suspended'], to: 'active', event: 'reinstated' },
  remove: { from: ['active', 'suspended'], to: 'removed', event: 'removed' },
};
async function setStatus(ctx, memberId, action) {
  enabled(); ownerOnly(ctx);
  const spec = STATUS_ACTIONS[action];
  if (!spec) throw err(400, 'BAD_ACTION', 'Unknown action.');
  return withTransaction(async (client) => {
    const m = await ownMember(client, ctx, memberId);
    if (!spec.from.includes(m.status)) throw err(409, 'BAD_TRANSITION', 'That change is not available for this person now.');
    const u = (await client.query(
      `UPDATE seller_staff_members SET status = $2, removed_by = CASE WHEN $2 = 'removed' THEN $3::uuid ELSE removed_by END,
              removed_at = CASE WHEN $2 = 'removed' THEN now() ELSE removed_at END, updated_at = now() WHERE id = $1 RETURNING *`,
      [m.id, spec.to, ctx.userId])).rows[0];
    await event(client, m, spec.event, ctx.userId, 'owner', { from: m.status, to: spec.to });
    return memberView(u);
  });
}

async function findInvitation(runner, token, lock = false) {
  if (!token || String(token).length < 20 || String(token).length > 200) return null;
  return (await runner.query(`SELECT * FROM seller_staff_members WHERE invite_token_hash = $1${lock ? ' FOR UPDATE' : ''}`, [hashToken(token)])).rows[0] || null;
}

async function previewInvite(userId, token) {
  enabled();
  const m = await findInvitation(db, token);
  if (!m || m.status !== 'invited' || new Date(m.invite_expires_at) <= new Date()) throw err(404, 'INVITE_NOT_FOUND', 'This invitation is no longer valid. Ask the company owner to send a new one.');
  const u = (await db.query('SELECT lower(email) AS email FROM users WHERE id = $1', [userId])).rows[0];
  return { company: await companyName(m.seller_id), role: m.role, role_label: SELLER_ROLES[m.role].label,
    email_matches: !!u && u.email === m.invited_email, expires_at: m.invite_expires_at };
}

async function acceptInvite(userId, token, deps = {}) {
  enabled();
  const out = await withTransaction(async (client) => {
    const m = await findInvitation(client, token, true);
    if (!m || m.status !== 'invited') throw err(404, 'INVITE_NOT_FOUND', 'This invitation is no longer valid. Ask the company owner to send a new one.');
    if (new Date(m.invite_expires_at) <= new Date()) {
      await client.query(`UPDATE seller_staff_members SET status = 'expired', invite_token_hash = NULL, updated_at = now() WHERE id = $1`, [m.id]);
      await event(client, m, 'invite_expired', null, 'system');
      return { expired: true };
    }
    const u = (await client.query('SELECT id, lower(email) AS email, COALESCE(is_active, true) AS active FROM users WHERE id = $1', [userId])).rows[0];
    if (!u || !u.active) throw err(403, 'NO_USER', 'Account not available.');
    if (u.email !== m.invited_email) throw err(403, 'EMAIL_MISMATCH', 'This invitation was sent to a different email address. Sign in with that email to accept it.');
    if ((await client.query('SELECT 1 FROM seller_profiles WHERE user_id = $1', [userId])).rowCount) {
      throw err(409, 'INVITEE_IS_OWNER', 'Your account owns a seller company, so it cannot also be staff.');
    }
    if ((await client.query(`SELECT 1 FROM seller_staff_members WHERE user_id = $1 AND status IN ('active','suspended')`, [userId])).rowCount) {
      throw err(409, 'ALREADY_STAFF', 'Your account is already staff for a seller company.');
    }
    const a = (await client.query(
      `UPDATE seller_staff_members SET user_id = $2, status = 'active', accepted_at = now(), invite_token_hash = NULL, updated_at = now()
        WHERE id = $1 RETURNING *`, [m.id, userId])).rows[0];
    await event(client, m, 'accepted', userId, 'staff', { role: m.role });
    return { member: a };
  });
  if (out.expired) throw err(410, 'INVITE_EXPIRED', 'This invitation has expired. Ask the company owner to send a new one.');
  const company = await companyName(out.member.seller_id);
  try {
    const owner = (await db.query('SELECT u.email FROM seller_profiles sp JOIN users u ON u.id = sp.user_id WHERE sp.id = $1', [out.member.seller_id])).rows[0];
    const mail = deps.emailService || require('./emailService');
    if (owner && owner.email) {
      await mail.sendEmail({ to: owner.email, subject: `${out.member.invited_email} joined your Advantage.Bid seller team`,
        text: `${out.member.invited_email} accepted your invitation and now has ${SELLER_ROLES[out.member.role].label} access to ${company}.\n\nIf you did not expect this, remove them from your team page right away: ${base()}/seller-staff.html` });
    }
  } catch (e) { console.error('[seller-staff] owner notice failed:', e.message); }
  return { company, role: out.member.role, role_label: SELLER_ROLES[out.member.role].label };
}

async function myMembership(userId, runner = db) {
  if (!sellerStaffEnabled()) return null;
  const m = (await runner.query(
    `SELECT m.id, m.seller_id, m.role, m.status FROM seller_staff_members m WHERE m.user_id = $1 AND m.status IN ('active','suspended')`, [userId])).rows[0];
  if (!m) return null;
  return { company: await companyName(m.seller_id, runner), role: m.role, role_label: SELLER_ROLES[m.role].label, status: m.status,
    permissions: m.status === 'active' ? [...permissionsForRole(m.role)] : [] };
}

module.exports = { STAFF_ROLES, INVITE_DAYS, INVITES_PER_DAY, listTeam, invite, revokeInvite, changeRole, setStatus,
  previewInvite, acceptInvite, myMembership, _hashToken: hashToken };
