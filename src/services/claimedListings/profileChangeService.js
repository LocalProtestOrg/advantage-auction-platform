'use strict';

/**
 * profileChangeService — identity changes on a CLAIMED DIRECTORY LISTING go to review (blueprint section 8).
 *
 * After a listing is claimed, the owner edits the profile exactly as before (nothing about the Free
 * Business Listing editor or the existing publication/moderation controls changes). The only difference:
 * a change to the company NAME, the website ROOT DOMAIN or the CONTACT EMAIL is held for staff review
 * instead of applying immediately, because those three are what a takeover would change. Changing the
 * contact email also sends a security notice to the OLD address. Advantage.Bid keeps full authority: an
 * admin approves or rejects each request, and admin edits are never intercepted.
 */

const db = require('../../db');
const auditService = require('../auditService');
const { normalizeEmail } = require('../../lib/emailNormalize');
const seg = require('../eventPartners/relationshipSegmentationService');
const tasks = require('./taskService');

const FIELDS = ['name', 'website_url', 'contact_email'];

/** Does this edit change a protected field? Pure. Path-only website edits on the same domain pass. */
function protectedChanges(org, updates) {
  const out = [];
  if (Object.prototype.hasOwnProperty.call(updates, 'name') && String(updates.name || '').trim()
      && seg.normalizeName(updates.name) !== seg.normalizeName(org.name)) out.push({ field: 'name', old: org.name, value: String(updates.name).trim() });
  if (Object.prototype.hasOwnProperty.call(updates, 'website_url')) {
    const before = seg.rootDomain(org.website_url); const after = seg.rootDomain(updates.website_url);
    if (after !== before && (after || before)) out.push({ field: 'website_url', old: org.website_url, value: updates.website_url || null });
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'contact_email')
      && normalizeEmail(updates.contact_email || '') !== normalizeEmail(org.contact_email || '')) {
    out.push({ field: 'contact_email', old: org.contact_email, value: updates.contact_email || null });
  }
  return out;
}

/** Applies to a claimed directory listing only (a BD-imported organization). */
const isClaimedListing = (org) => !!(org && (org.bd_listing_id || org.source === 'bd_import'));

/**
 * Intercept an owner's profile update. Returns { updates, held: [...] }: `updates` minus the protected
 * fields, which become pending review requests (idempotent per field: a newer request supersedes).
 */
async function intercept(org, updates, { userId }, runner = db) {
  if (!isClaimedListing(org)) return { updates, held: [] };
  // Only listings claimed through the Claimed Listing flow (which opens an activation track). Members who
  // claimed before this feature keep exactly the editing behaviour they have today.
  const tracked = (await runner.query(`SELECT 1 FROM listing_activation_progress WHERE organization_id = $1`, [org.id]).catch(() => ({ rows: [] }))).rows[0];
  if (!tracked) return { updates, held: [] };
  const changes = protectedChanges(org, updates || {});
  if (!changes.length) return { updates, held: [] };
  const kept = Object.assign({}, updates);
  const held = [];
  for (const c of changes) {
    delete kept[c.field];
    await runner.query(`UPDATE organization_profile_change_requests SET status = 'superseded' WHERE organization_id = $1 AND field = $2 AND status = 'pending'`, [org.id, c.field]);
    const r = (await runner.query(
      `INSERT INTO organization_profile_change_requests (organization_id, requested_by, field, old_value, new_value)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`, [org.id, userId, c.field, c.old || null, c.value])).rows[0];
    held.push({ id: r.id, field: c.field, requested: c.value });
    await tasks.open({ type: 'profile_change_review', organizationId: org.id, summary: 'Review ' + c.field.replace('_url', '') + ' change: ' + org.name,
      payload: { request_id: r.id, field: c.field, from: c.old || null, to: c.value }, dedupeKey: 'pcr:' + r.id }, runner);
    await auditService.logEvent(runner, { eventType: 'organization.profile_change_requested', entityType: 'organization', entityId: org.id, actorId: userId,
      metadata: { field: c.field, request_id: r.id } }).catch(() => {});
    if (c.field === 'contact_email' && normalizeEmail(org.contact_email || '')) notifyOldAddress(org).catch(() => {});
  }
  return { updates: kept, held };
}

/** Security notice to the address being replaced (transactional; no link that could approve anything). */
async function notifyOldAddress(org) {
  const emailService = require('../emailService');
  const text = 'Someone managing the ' + org.name + ' listing on Advantage.Bid asked to change its contact email address.\n\n'
    + 'Our team reviews this change before it takes effect. If you did not expect it, call (551) 655-7050 or email info@advantage.bid and we will hold it.\n\n'
    + 'Advantage.Bid';
  await emailService.sendEmail({ to: normalizeEmail(org.contact_email), subject: 'Contact email change requested for ' + org.name,
    text, html: '<p>' + text.split('\n\n').map((p) => p.replace(/[<>&]/g, '')).join('</p><p>') + '</p>' });
}

/** Admin decision. Approve applies the change; reject leaves the profile as it is. Audited. */
async function decide(requestId, { approve, actorId, reason = null }, runner = db) {
  const r = (await runner.query(`SELECT * FROM organization_profile_change_requests WHERE id = $1 AND status = 'pending'`, [requestId])).rows[0];
  if (!r) throw Object.assign(new Error('No pending request.'), { status: 404, expose: true });
  if (!FIELDS.includes(r.field)) throw new Error('unexpected field');
  if (approve) await runner.query(`UPDATE organizations SET ${r.field} = $2, updated_at = now() WHERE id = $1`, [r.organization_id, r.new_value]);
  const upd = (await runner.query(
    `UPDATE organization_profile_change_requests SET status = $2, decided_by = $3, decided_at = now(), decision_reason = $4 WHERE id = $1 RETURNING *`,
    [requestId, approve ? 'approved' : 'rejected', actorId, reason])).rows[0];
  await runner.query(`UPDATE listing_tasks SET status = 'done', resolved_by = $2, resolved_at = now(), resolution = $3, updated_at = now()
    WHERE dedupe_key = $1`, ['pcr:' + requestId, actorId, approve ? 'approved' : 'rejected']);
  await auditService.logEvent(runner, { eventType: 'organization.profile_change_' + (approve ? 'approved' : 'rejected'), entityType: 'organization',
    entityId: r.organization_id, actorId, metadata: { field: r.field, request_id: requestId, reason } }).catch(() => {});
  return upd;
}

async function pendingFor(organizationId, runner = db) {
  return (await runner.query(`SELECT id, field, new_value, created_at FROM organization_profile_change_requests WHERE organization_id = $1 AND status = 'pending'`, [organizationId])).rows;
}

module.exports = { FIELDS, protectedChanges, isClaimedListing, intercept, decide, pendingFor };
