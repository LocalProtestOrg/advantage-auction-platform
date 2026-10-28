'use strict';

/**
 * adminMemberService — the Admin Member Detail record (/admin/member.html, /api/admin/users/:id/...).
 *
 * One account per person: every change edits the existing users / seller_profiles rows, never a copy. Buyer history
 * (bids, registrations, invoices, payments, orders) is keyed by users.id and is never touched here, so converting a buyer
 * into a Professional Seller keeps all of it; the 'seller' role keeps every buyer capability (buyer routes accept it).
 *
 * Safeguards (all server-side):
 *   - Converting to a Professional Seller NEVER approves verification or payout setup: it engages the SAME publication
 *     gate (verificationService.requireVerificationForProfessional) that a self-enrolled Professional gets, so checkout
 *     and first publication stay closed (sellerSaleEligibility) until an admin approves verification.
 *   - Admin / Super Admin access is not granted here; it stays on Staff & Permissions (staff.manage, last-Super-Admin rule).
 *   - An admin cannot suspend or sign out their own account here, and the last active Super Admin cannot be suspended.
 *   - Passwords are never shown or set: the account owner receives the standard single-use reset email.
 *   - Payment, payout and Stripe records are read-only.
 *   - Every sensitive change is written to audit_log with actor, member, field, previous and new value and a reason.
 */

const db = require('../db');
const rbac = require('../lib/rbac');
const { writeAuditLog } = require('../lib/auditLog');
const { PROFESSIONAL_SELLER_TYPES, SELLER_TYPE_LABELS } = require('../constants/sellerTypes');
const { isProfessional } = require('./sellerTypeRules');

function err(status, code, message, extra) { const e = new Error(message); e.status = status; e.code = code; if (extra) e.extra = extra; return e; }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function assertUuid(id) { if (!UUID_RE.test(String(id || ''))) throw err(404, 'NOT_FOUND', 'User not found'); }

// A reason is required for high-impact changes; stored with the audit event.
function reasonOf(v, required = true) {
  const r = (v == null ? '' : String(v)).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 500);
  if (required && r.length < 5) throw err(422, 'REASON_REQUIRED', 'Please give a reason (at least 5 characters). It is saved in the audit history.');
  return r || null;
}

// Read-only sections must not fail the whole page when an optional table is absent in an environment.
async function safe(fn, fallback) {
  try { return await fn(); } catch (e) { if (e && (e.code === '42P01' || e.code === '42703')) return fallback; throw e; }
}

async function loadUser(userId, runner = db) {
  assertUuid(userId);
  // Whole row (columns vary by migration level), minus the credential columns, which never leave this function.
  const row = (await runner.query('SELECT * FROM users WHERE id = $1', [userId])).rows[0];
  if (!row) throw err(404, 'NOT_FOUND', 'User not found');
  const { password_hash: _p, ...u } = row;
  return u;
}

function effectiveSuperAdmin(u) { return rbac.isSuperAdmin(u) && (u.role === 'admin' || u.staff_active !== false); }

// Active Super Admins other than `excludeId` (same rule as Staff & Permissions lockout protection).
async function otherActiveSuperAdmins(excludeId, runner = db) {
  return (await runner.query(
    `SELECT count(*)::int AS n FROM users
      WHERE id <> $1 AND is_active IS NOT FALSE
        AND ((role = 'admin') OR (staff_role = 'super_admin' AND staff_active IS NOT FALSE))`, [excludeId])).rows[0].n;
}

// ── Read: the full member record ─────────────────────────────────────────────────────────────────────────────────────
async function getMemberAccount(userId) {
  const u = await loadUser(userId);
  const overrides = await safe(async () => (await db.query('SELECT permission, effect FROM staff_permission_overrides WHERE user_id = $1', [u.id])).rows, []);
  const staffCtx = { role: u.role, staff_role: u.staff_role, staff_active: u.staff_active, overrides };
  const sp = (await db.query(
    `SELECT id, display_name, seller_type, storefront_slug, storefront_published, verification_required_before_publication,
            risk_level, is_demo, created_at
       FROM seller_profiles WHERE user_id = $1`, [u.id])).rows[0] || null;

  let seller = null;
  if (sp) {
    const verificationService = require('./verificationService');
    const gate = await verificationService.publicationGate(sp.id);
    const requests = await safe(async () => (await db.query(
      `SELECT id, status, created_at, reviewed_at FROM verification_requests WHERE seller_profile_id = $1 ORDER BY created_at DESC LIMIT 20`, [sp.id])).rows, []);
    const business = await safe(() => verificationService.getBusinessInfo(sp.id), null);
    // Read-only agreement status (dashboardAccess never sends anything; getOnboardingStatus would auto-send).
    const agreement = await safe(() => require('./agreementService').dashboardAccess(sp.id), null);
    const base = String(process.env.PUBLIC_APP_URL || 'https://bid.advantage.bid').replace(/\/+$/, '');
    const items = await safe(async () => (await db.query(
      `SELECT status, count(*)::int AS n FROM marketplace_items WHERE seller_id = $1 GROUP BY status`, [sp.id])).rows, []);
    seller = {
      id: sp.id, display_name: sp.display_name, seller_type: sp.seller_type,
      seller_type_label: SELLER_TYPE_LABELS[sp.seller_type] || sp.seller_type || 'Individual',
      classification: isProfessional(sp.seller_type) ? 'professional' : 'individual',
      is_demo: !!sp.is_demo, risk_level: sp.risk_level, created_at: sp.created_at,
      verification: { required_before_publication: !!sp.verification_required_before_publication, gate,
        approved: requests.some((r) => r.status === 'approved'), requests },
      agreement: agreement ? { dashboard_access: agreement.access, reason: agreement.reason, agreement_id: agreement.agreement_id } : null,
      business,
      storefront: { slug: sp.storefront_slug, published: !!sp.storefront_published,
        public_url: sp.storefront_slug ? `${base}/pro/${sp.storefront_slug}` : null,
        items_by_status: Object.fromEntries(items.map((r) => [r.status, r.n])) },
    };
  }

  const org = await safe(() => require('./organizationsService').getPrimaryOrgForUser(u.id), null);

  // Payout setup: read-only status only (no account or bank identifiers).
  let payouts = null;
  if (sp) {
    const connect = require('./stripeConnectService');
    const pref = await safe(() => connect.getPref(u.id), null);
    payouts = {
      connect_status: (pref && pref.connect_status) || 'not_started',
      details_submitted: !!(pref && pref.connect_details_submitted),
      transfers_active: !!(pref && pref.connect_transfers_active),
      payouts_enabled: !!(pref && pref.connect_payouts_enabled),
      disabled_reason: (pref && pref.connect_disabled_reason) || null,
      updated_at: (pref && pref.connect_updated_at) || null,
      ready: connect.isConnectReady(pref),
    };
  }

  const sellerActivity = sp ? {
    auctions: await safe(async () => (await db.query(
      `SELECT id, title, state, created_at FROM auctions WHERE seller_id = $1 ORDER BY created_at DESC LIMIT 50`, [sp.id])).rows, []),
    items: await safe(async () => (await db.query(
      `SELECT id, title, status, price_cents, created_at FROM marketplace_items WHERE seller_id = $1 ORDER BY created_at DESC LIMIT 25`, [sp.id])).rows, []),
    orders: await safe(async () => (await db.query(
      `SELECT id, order_number, payment_status, fulfillment_status, total_charge_cents, created_at
         FROM marketplace_orders WHERE seller_id = $1 ORDER BY created_at DESC LIMIT 50`, [sp.id])).rows, []),
    settlements: await safe(async () => (await db.query(
      `SELECT sp2.id, sp2.auction_id, a.title AS auction_title, sp2.seller_payout_cents, sp2.payout_status, sp2.created_at
         FROM seller_payouts sp2 LEFT JOIN auctions a ON a.id = sp2.auction_id
        WHERE sp2.seller_user_id = $1 ORDER BY sp2.created_at DESC LIMIT 50`, [u.id])).rows, []),
  } : null;

  const buyerOrders = await safe(async () => (await db.query(
    `SELECT id, order_number, payment_status, fulfillment_status, total_charge_cents, created_at
       FROM marketplace_orders WHERE buyer_user_id = $1 ORDER BY created_at DESC LIMIT 50`, [u.id])).rows, []);

  return {
    id: u.id,
    personal: {
      full_name: u.full_name, email: u.email, email_verified: !!u.email_verified, phone: u.phone,
      phone_verified: !!u.phone_verified_at, auth_source: u.auth_source || 'native',
      tax_address: { line1: u.tax_address_line1, line2: u.tax_address_line2, city: u.tax_city, state: u.tax_state,
        postal_code: u.tax_postal_code, country: u.tax_country },
    },
    access: {
      role: u.role, staff_role: u.staff_role || null, staff_active: u.staff_active !== false,
      is_super_admin: effectiveSuperAdmin(u), is_staff: rbac.isStaff(u),
      can_buy: u.is_active !== false, can_sell: !!sp, professional: !!(sp && isProfessional(sp.seller_type)),
      staff_permissions: rbac.isStaff(u) ? Array.from(rbac.permissionsForUser(staffCtx)).sort() : [],
    },
    status: { is_active: u.is_active !== false, is_demo: !!u.is_demo, created_at: u.created_at, last_login_at: u.last_login_at },
    seller, organization: org ? { id: org.id, name: org.name, slug: org.slug } : null,
    payouts, seller_activity: sellerActivity, buyer_orders: buyerOrders,
    history: await history(u.id, sp && sp.id),
  };
}

async function history(userId, sellerProfileId) {
  return safe(async () => (await db.query(
    `SELECT al.id, al.event_type, al.entity_type, al.metadata, al.created_at, al.actor_id, au.email AS actor_email
       FROM audit_log al LEFT JOIN users au ON au.id = al.actor_id
      WHERE (al.entity_type = 'user' AND al.entity_id = $1)
         OR ($2::uuid IS NOT NULL AND al.entity_type = 'seller_profile' AND al.entity_id = $2::uuid)
      ORDER BY al.created_at DESC LIMIT 100`, [userId, sellerProfileId || null])).rows, []);
}

// ── Personal information ─────────────────────────────────────────────────────────────────────────────────────────────
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ADDRESS_FIELDS = { tax_address_line1: 200, tax_address_line2: 200, tax_city: 120, tax_state: 2, tax_postal_code: 10, tax_country: 2 };
const text = (v, max) => { const s = (v == null ? '' : String(v)).replace(/[\u0000-\u001f]+/g, ' ').trim(); return s ? s.slice(0, max) : null; };

async function updatePersonal(userId, actorId, body = {}) {
  const before = await loadUser(userId);
  const next = {};
  if ('full_name' in body) next.full_name = text(body.full_name, 200);
  if ('phone' in body) {
    next.phone = text(body.phone, 40);
    if (next.phone && next.phone.replace(/\D/g, '').length < 10) throw err(422, 'INVALID_PHONE', 'Please enter a valid phone number (at least 10 digits).');
  }
  if ('email' in body) {
    const email = String(body.email == null ? '' : body.email).trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 254) throw err(422, 'INVALID_EMAIL', 'Please enter a valid email address.');
    if (email !== String(before.email || '').trim().toLowerCase()) {
      // The sign-in identity of staff and admins is managed only on Staff & Permissions.
      if (rbac.isStaff(before)) throw err(409, 'STAFF_IDENTITY', 'Staff and admin sign-in emails are changed from Staff & Permissions only.');
      if ((before.auth_source || 'native') === 'bd_bridge') throw err(409, 'LINKED_IDENTITY', 'This account signs in through the directory link; its email cannot be changed here.');
      const taken = (await db.query('SELECT 1 FROM users WHERE lower(btrim(email)) = $1 AND id <> $2', [email, before.id])).rowCount;
      if (taken) throw err(409, 'EMAIL_TAKEN', 'Another account already uses that email address.');
      next.email = email;
    }
  }
  for (const [f, max] of Object.entries(ADDRESS_FIELDS)) {
    if (!(f in body)) continue;
    let v = text(body[f], 500);
    // Validate the value as given (never truncate a code into something valid-looking).
    if (v && v.length > max) throw err(422, 'INVALID_ADDRESS', f === 'tax_state' ? 'State must be a two-letter code.' : f === 'tax_country' ? 'Country must be a two-letter code.' : 'That address line is too long.');
    if (v && (f === 'tax_state' || f === 'tax_country')) {
      v = v.toUpperCase();
      if (!/^[A-Z]{2}$/.test(v)) throw err(422, 'INVALID_ADDRESS', f === 'tax_state' ? 'State must be a two-letter code.' : 'Country must be a two-letter code.');
    }
    if (v && f === 'tax_postal_code' && !/^[0-9A-Za-z \-]{3,10}$/.test(v)) throw err(422, 'INVALID_ADDRESS', 'Please enter a valid postal code.');
    next[f] = v;
  }
  const changes = Object.keys(next).filter((f) => (before[f] == null ? null : String(before[f])) !== (next[f] == null ? null : String(next[f])))
    .map((f) => ({ field: f, before: before[f] == null ? null : before[f], after: next[f] }));
  if (!changes.length) return { changed: false, changes: [] };
  // Email and billing address changes are high impact (sign-in identity; tax jurisdiction evidence).
  const highImpact = changes.some((c) => c.field === 'email' || c.field.startsWith('tax_'));
  const reason = reasonOf(body.reason, highImpact);

  const sets = [], params = [before.id];
  for (const c of changes) { params.push(c.after); sets.push(`${c.field} = $${params.length}`); }
  if (changes.some((c) => c.field === 'email')) sets.push('email_verified = false');
  try {
    await db.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, params);
  } catch (e) {
    if (e && e.code === '23505') throw err(409, 'EMAIL_TAKEN', 'Another account already uses that email address.');
    throw e;
  }
  // An admin can correct a phone number but cannot verify one.
  let phoneVerificationCleared = false;
  if (changes.some((c) => c.field === 'phone')) {
    phoneVerificationCleared = (await safe(async () => (await db.query(
      `UPDATE users SET phone_verified_at = NULL, phone_verified_e164 = NULL
        WHERE id = $1 AND phone_verified_e164 IS NOT NULL AND phone IS DISTINCT FROM phone_verified_e164 RETURNING id`, [before.id])).rowCount, 0)) > 0;
  }
  await writeAuditLog({ event_type: 'user.profile_updated', entity_type: 'user', entity_id: before.id, actor_id: actorId,
    metadata: { changes, reason, email_verification_cleared: changes.some((c) => c.field === 'email'), phone_verification_cleared: phoneVerificationCleared } });
  return { changed: true, changes };
}

// ── Seller: convert an existing account into a Professional Seller ───────────────────────────────────────────────────
async function convertToProfessional(userId, actorId, body = {}) {
  const sellerType = String(body.seller_type || '').trim().toLowerCase();
  if (!PROFESSIONAL_SELLER_TYPES.includes(sellerType)) {
    throw err(422, 'INVALID_PROFESSIONAL_TYPE', 'Choose a Professional Seller type: auction house, estate sale company or professional liquidator.');
  }
  const companyName = text(body.company_name, 200);
  if (!companyName) throw err(422, 'COMPANY_REQUIRED', 'A company or business name is required.');
  const reason = reasonOf(body.reason);
  if (body.confirm !== true) throw err(422, 'CONFIRM_REQUIRED', 'Confirm the change to continue.');

  const client = await db.connect();
  let result;
  try {
    await client.query('BEGIN');
    const u = (await client.query('SELECT id, email, role, is_active, phone FROM users WHERE id = $1 FOR UPDATE', [userId])).rows[0];
    if (!u) throw err(404, 'NOT_FOUND', 'User not found');
    if (u.is_active === false) throw err(409, 'ACCOUNT_SUSPENDED', 'Reactivate the account before changing it to a Professional Seller.');
    const existing = (await client.query('SELECT id, seller_type, display_name FROM seller_profiles WHERE user_id = $1 FOR UPDATE', [u.id])).rows[0];
    if (existing && isProfessional(existing.seller_type)) {
      throw err(409, 'ALREADY_PROFESSIONAL', 'This account is already a Professional Seller. Change its type under Seller Profile.');
    }
    if (existing) {
      // Professional controls apply to an Individual Seller's submitted auctions once the type changes: say so first.
      const submitted = (await client.query(`SELECT count(*)::int AS n FROM auctions WHERE seller_id = $1 AND state <> 'draft'`, [existing.id])).rows[0].n;
      if (submitted > 0 && body.acknowledge_submitted_auctions !== true) {
        throw err(409, 'SUBMITTED_AUCTIONS', `This seller has ${submitted} submitted auction(s) as an Individual Seller. Professional controls will apply to them. Confirm to continue.`, { submitted_auctions: submitted });
      }
    }
    let sellerProfileId;
    if (existing) {
      sellerProfileId = existing.id;
      await client.query(
        `UPDATE seller_profiles SET seller_type = $2, display_name = COALESCE(NULLIF(display_name, ''), $3) WHERE id = $1`,
        [existing.id, sellerType, companyName]);
    } else {
      sellerProfileId = (await client.query(
        `INSERT INTO seller_profiles (user_id, seller_type, display_name) VALUES ($1, $2, $3) RETURNING id`,
        [u.id, sellerType, companyName])).rows[0].id;
    }
    // The same publication gate as a self-enrolled Professional: never an approval.
    await require('./verificationService').requireVerificationForProfessional(sellerProfileId, sellerType, actorId, client);
    // Buyer → Seller keeps every buyer capability; an admin keeps the admin role.
    await client.query(`UPDATE users SET role = CASE WHEN role = 'buyer' THEN 'seller' ELSE role END WHERE id = $1`, [u.id]);
    const newRole = (await client.query('SELECT role FROM users WHERE id = $1', [u.id])).rows[0].role;
    await client.query('COMMIT');
    result = { user: u, existing, sellerProfileId, newRole };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  const { user: u, existing, sellerProfileId, newRole } = result;
  // The current database role is used by every request; drop this account's cached session state so it applies now.
  require('../lib/sessionTokens').forgetUser(u.id);

  // Best-effort follow-ups, as in self-service Professional enrollment (src/routes/sellers.js apply-professional).
  let organizationId = null;
  try {
    const orgs = require('./organizationsService');
    let org = await orgs.getPrimaryOrgForUser(u.id);
    if (!org) org = await orgs.onboardOrganization(u.id, { name: companyName, type: sellerType, contactEmail: u.email || undefined, contactPhone: u.phone || undefined });
    if (org) {
      organizationId = org.id;
      await db.query(
        `UPDATE organizations SET linked_seller_profile_id = $2, linked_seller_at = COALESCE(linked_seller_at, now())
          WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM organizations WHERE linked_seller_profile_id = $2 AND id <> $1)`, [org.id, sellerProfileId]);
    }
  } catch (e) { console.error('[admin-member] organization link best-effort failed:', e.message); }
  let agreement = null;
  if (body.send_agreement !== false) {
    try { agreement = await require('./agreementService').autoSendAgreement(sellerProfileId, actorId); }
    catch (e) { console.error('[admin-member] agreement send best-effort failed:', e.message); }
  }

  const changes = [
    { field: 'role', before: u.role, after: newRole },
    { field: 'seller_type', before: existing ? existing.seller_type : null, after: sellerType },
  ];
  if (!existing) changes.push({ field: 'seller_profile', before: null, after: sellerProfileId });
  await writeAuditLog({ event_type: 'user.converted_to_professional', entity_type: 'user', entity_id: u.id, actor_id: actorId,
    metadata: { changes, reason, seller_profile_id: sellerProfileId, company_name: companyName,
      verification_required_before_publication: true, verification_approved: false, payout_setup: 'unchanged',
      agreement: agreement && agreement.status, organization_id: organizationId } });
  return { seller_profile_id: sellerProfileId, role: newRole, seller_type: sellerType, created_profile: !existing,
    verification_required_before_publication: true, agreement: agreement && agreement.status, organization_id: organizationId };
}

// ── Seller: edit an existing profile ─────────────────────────────────────────────────────────────────────────────────
async function updateSellerProfile(userId, actorId, body = {}) {
  const u = await loadUser(userId);
  const sp = (await db.query('SELECT id, seller_type, display_name FROM seller_profiles WHERE user_id = $1', [u.id])).rows[0];
  if (!sp) throw err(404, 'NO_SELLER_PROFILE', 'This account has no seller profile.');
  const changes = [];
  if ('display_name' in body) {
    const name = text(body.display_name, 200);
    if (!name) throw err(422, 'COMPANY_REQUIRED', 'A business or display name is required.');
    if (name !== sp.display_name) changes.push({ field: 'display_name', before: sp.display_name, after: name });
  }
  if ('seller_type' in body) {
    const t = String(body.seller_type || '').trim().toLowerCase();
    if (t !== sp.seller_type) {
      // Individual → Professional goes through the conversion (verification gate, agreement); Professional →
      // Individual is not offered here (storefront, pricing and fee consequences need a separate reviewed process).
      if (!isProfessional(sp.seller_type)) throw err(409, 'USE_CONVERSION', 'Use "Make Professional Seller" to change an Individual Seller.');
      if (!PROFESSIONAL_SELLER_TYPES.includes(t)) throw err(409, 'DOWNGRADE_NOT_SUPPORTED', 'Changing a Professional Seller back to an Individual Seller is not available here.');
      changes.push({ field: 'seller_type', before: sp.seller_type, after: t });
    }
  }
  if (!changes.length) return { changed: false, changes: [] };
  const reason = reasonOf(body.reason, changes.some((c) => c.field === 'seller_type'));
  const sets = [], params = [sp.id];
  for (const c of changes) { params.push(c.after); sets.push(`${c.field} = $${params.length}`); }
  await db.query(`UPDATE seller_profiles SET ${sets.join(', ')} WHERE id = $1`, params);
  const typeChange = changes.find((c) => c.field === 'seller_type');
  if (typeChange) await require('./verificationService').requireVerificationForProfessional(sp.id, typeChange.after, actorId);
  await writeAuditLog({ event_type: 'seller_profile.updated', entity_type: 'seller_profile', entity_id: sp.id, actor_id: actorId,
    metadata: { user_id: u.id, changes, reason } });
  return { changed: true, changes };
}

// ── Account status & security ────────────────────────────────────────────────────────────────────────────────────────
async function setStatus(userId, actorId, body = {}) {
  const status = (body && body.status) || '';
  if (!['active', 'suspended'].includes(status)) throw err(400, 'INVALID_STATUS', "status must be 'active' or 'suspended'");
  const u = await loadUser(userId);
  const active = status === 'active';
  if (!active) {
    if (String(u.id) === String(actorId)) throw err(409, 'SELF_LOCKOUT', 'You cannot suspend your own account.');
    if (effectiveSuperAdmin(u) && (await otherActiveSuperAdmins(u.id)) < 1) throw err(409, 'LAST_ADMIN', 'Refusing to suspend the last active Super Admin.');
  }
  const reason = reasonOf(body.reason, !active);
  const row = (await db.query(`UPDATE users SET is_active = $2 WHERE id = $1 RETURNING id, email, is_active`, [u.id, active])).rows[0];
  require('../lib/accountStatus').invalidateAccountStatus(u.id); // apply on this instance now, not after the cache TTL
  if (!active) await require('../lib/sessionTokens').endAllSessions(null, u.id, 'account suspended'); // signs the account out everywhere
  await writeAuditLog({ event_type: active ? 'user.reactivated' : 'user.suspended', entity_type: 'user', entity_id: u.id, actor_id: actorId,
    metadata: { email: u.email, changes: [{ field: 'is_active', before: u.is_active !== false, after: active }],
      previous_is_active: u.is_active, new_is_active: active, reason } });
  return row;
}

async function endSessions(userId, actorId, body = {}) {
  const u = await loadUser(userId);
  if (String(u.id) === String(actorId)) throw err(409, 'SELF_LOCKOUT', 'Use Log out to end your own sign-in.');
  const reason = reasonOf(body.reason);
  await require('../lib/sessionTokens').endAllSessions(null, u.id, 'ended by an administrator');
  await writeAuditLog({ event_type: 'user.sessions_ended', entity_type: 'user', entity_id: u.id, actor_id: actorId, metadata: { reason } });
  return { ended: true };
}

async function sendPasswordReset(userId, actorId, body = {}, opts = {}) {
  const u = await loadUser(userId);
  if (u.is_active === false) throw err(409, 'ACCOUNT_SUSPENDED', 'Reactivate the account before sending a password reset.');
  if (!u.email) throw err(409, 'NO_EMAIL', 'This account has no email address.');
  const reason = reasonOf(body.reason);
  // The standard single-use reset email to the account's own address; no password or link is shown to the admin.
  await require('./passwordResetService').requestReset(u.email, { ip: opts.ip, baseUrl: opts.baseUrl });
  await writeAuditLog({ event_type: 'user.password_reset_sent', entity_type: 'user', entity_id: u.id, actor_id: actorId, metadata: { email: u.email, reason } });
  return { sent: true };
}

module.exports = {
  getMemberAccount, updatePersonal, convertToProfessional, updateSellerProfile, setStatus, endSessions, sendPasswordReset,
  _internal: { reasonOf, otherActiveSuperAdmins },
};
